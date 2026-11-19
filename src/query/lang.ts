/**
 * The `query` block language: parsing, evaluation and small text utilities.
 * Pure TypeScript shared by the extension host (evaluation) and the webview
 * (rendering, completions). See tasks/markdown-query-tables for the spec.
 */

export type SortDir = 'asc' | 'desc';

export interface Query {
  from?: string;
  where: Expr[];
  sort: { field: string; dir: SortDir }[];
  /** Max rows evaluated; `Infinity` when `page_size` is set without an explicit `limit`. */
  limit: number;
  columns?: string[];
  /** Rows per page in the rendered table (`page_size`, alias `page`). */
  page?: number;
  /** Group rows by this field's value (array values put a file in each group). */
  group?: string;
  /** List the distinct values of this field with a file count instead of files. */
  distinct?: string;
}

export interface QueryError {
  message: string;
  /** 0-based line in the block text. */
  line: number;
}

export type Expr =
  | { type: 'and'; items: Expr[] }
  | { type: 'or'; items: Expr[] }
  | { type: 'not'; item: Expr }
  | { type: 'exists'; field: string }
  | { type: 'cmp'; field: string; op: CmpOp; value: Literal };

export type CmpOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'matches';

export type Literal =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'regex'; source: string; flags: string }
  | { kind: 'date'; ms: number }
  /** `$.field`: the value of the current file's own frontmatter field. */
  | { kind: 'ref'; field: string };

export const QUERY_KEYS = ['from', 'where', 'sort', 'limit', 'columns', 'page_size', 'group', 'distinct'] as const;
export const OPERATORS: CmpOp[] = [
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'contains',
  'startsWith',
  'endsWith',
  'matches',
];
export const FILE_FIELDS = [
  'file.path',
  'file.name',
  'file.folder',
  'file.modified',
  'file.created',
  'file.size',
] as const;
export const DEFAULT_COLUMNS = ['file.name', 'file.path', 'file.modified'];
export const DEFAULT_LIMIT = 50;

const FIELD_RE = /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/;

// ---------------------------------------------------------------------------
// Query parsing

export function parseQuery(text: string): { query: Query; errors: QueryError[] } {
  const query: Query = { where: [], sort: [], limit: DEFAULT_LIMIT };
  const errors: QueryError[] = [];
  const lines = text.split('\n');
  let explicitLimit = false;

  lines.forEach((raw, line) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!m) {
      errors.push({ line, message: `Expected "key: value", got "${trimmed}"` });
      return;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    switch (key) {
      case 'from':
        query.from = value || undefined;
        break;
      case 'where': {
        if (!value) {
          errors.push({ line, message: 'Empty where clause' });
          break;
        }
        try {
          query.where.push(parseExpr(value));
        } catch (e) {
          errors.push({ line, message: (e as Error).message });
        }
        break;
      }
      case 'sort': {
        const sm = /^(\S+)(?:\s+(asc|desc))?$/i.exec(value);
        if (!sm || !FIELD_RE.test(sm[1])) {
          errors.push({ line, message: `Expected "sort: <field> [asc|desc]", got "${value}"` });
          break;
        }
        query.sort.push({ field: sm[1], dir: (sm[2]?.toLowerCase() as SortDir) ?? 'asc' });
        break;
      }
      case 'limit':
      case 'page':
      case 'page_size': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          errors.push({ line, message: `${key} must be a positive integer, got "${value}"` });
          break;
        }
        if (key === 'limit') {
          query.limit = n;
          explicitLimit = true;
        } else {
          query.page = n;
        }
        break;
      }
      case 'group':
      case 'distinct': {
        if (!value) {
          query[key] = undefined;
          break;
        }
        if (!FIELD_RE.test(value)) {
          errors.push({ line, message: `Expected "${key}: <field>", got "${value}"` });
          break;
        }
        query[key] = value;
        break;
      }
      case 'columns': {
        const cols = value
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        const bad = cols.find((c) => !FIELD_RE.test(c));
        if (bad) {
          errors.push({ line, message: `Invalid column name "${bad}"` });
          break;
        }
        query.columns = cols;
        break;
      }
      default:
        errors.push({
          line,
          message: `Unknown key "${m[1]}". Expected one of ${QUERY_KEYS.join(', ')}`,
        });
    }
  });

  if (query.group && query.distinct) {
    errors.push({ line: 0, message: '"group" and "distinct" cannot be combined' });
  }
  // Paging exists to browse everything without a tall table, so a page size
  // lifts the default cap unless the author limited the query explicitly.
  if (query.page && !explicitLimit) query.limit = Infinity;
  if (query.sort.length === 0) {
    query.sort.push(query.distinct ? { field: 'count', dir: 'desc' } : { field: 'file.modified', dir: 'desc' });
  }
  return { query, errors };
}

/** Fields the result needs as columns when `columns` is omitted. */
export function effectiveColumns(query: Query): string[] {
  if (query.distinct) return [query.distinct, 'count'];
  if (query.columns && query.columns.length > 0) return query.columns;
  const cols = [...DEFAULT_COLUMNS];
  const add = (f: string) => {
    if (!cols.includes(f) && f !== query.group) cols.push(f);
  };
  for (const e of query.where) for (const f of fieldsOf(e)) add(f);
  for (const s of query.sort) add(s.field);
  return cols;
}

export function fieldsOf(expr: Expr): string[] {
  switch (expr.type) {
    case 'and':
    case 'or':
      return expr.items.flatMap(fieldsOf);
    case 'not':
      return fieldsOf(expr.item);
    default:
      return [expr.field];
  }
}

/** Rewrites the `sort:` lines of a block to a single `sort: field dir`. */
export function withSort(text: string, field: string, dir: SortDir): string {
  const lines = text.split('\n');
  const sortLine = `sort: ${field} ${dir}`;
  let replaced = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*sort\s*:/i.test(line)) {
      if (!replaced) {
        out.push(sortLine);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!replaced) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push(sortLine);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Expression parsing

type Token =
  | { t: 'ident'; v: string; pos: number }
  | { t: 'op'; v: string; pos: number }
  | { t: 'string'; v: string; pos: number }
  | { t: 'number'; v: number; pos: number }
  | { t: 'regex'; source: string; flags: string; pos: number }
  | { t: 'lparen'; pos: number }
  | { t: 'rparen'; pos: number }
  | { t: 'ref'; v: string; pos: number }
  | { t: 'eof'; pos: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const pos = i;
    if (c === '(') {
      tokens.push({ t: 'lparen', pos });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ t: 'rparen', pos });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j++];
        }
      }
      if (j >= src.length) throw new Error(`Unterminated string at column ${pos + 1}`);
      tokens.push({ t: 'string', v: s, pos });
      i = j + 1;
      continue;
    }
    if (c === '/') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '/') {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j] + src[j + 1];
          j += 2;
        } else {
          s += src[j++];
        }
      }
      if (j >= src.length) throw new Error(`Unterminated regex at column ${pos + 1}`);
      j++;
      let flags = '';
      while (j < src.length && /[a-z]/i.test(src[j])) flags += src[j++];
      tokens.push({ t: 'regex', source: s, flags, pos });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>='].includes(two)) {
      tokens.push({ t: 'op', v: two, pos });
      i += 2;
      continue;
    }
    if (c === '<' || c === '>' || c === '+' || c === '-') {
      tokens.push({ t: 'op', v: c, pos });
      i++;
      continue;
    }
    if (c === '=') throw new Error(`Unexpected "=" at column ${pos + 1}. Did you mean "=="?`);
    const rest = src.slice(i);
    if (c === '$') {
      const ref = /^\$\.([A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*)/.exec(rest);
      if (!ref) throw new Error(`Expected a field after "$." at column ${pos + 1}`);
      tokens.push({ t: 'ref', v: ref[1], pos });
      i += ref[0].length;
      continue;
    }
    const num = /^\d+(\.\d+)?(?![\w-])/.exec(rest);
    if (num) {
      tokens.push({ t: 'number', v: Number(num[0]), pos });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_\d][\w.-]*/.exec(rest);
    if (ident) {
      tokens.push({ t: 'ident', v: ident[0], pos });
      i += ident[0].length;
      continue;
    }
    throw new Error(`Unexpected character "${c}" at column ${pos + 1}`);
  }
  tokens.push({ t: 'eof', pos: src.length });
  return tokens;
}

export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const isWord = (w: string) => {
    const t = peek();
    return t.t === 'ident' && t.v.toLowerCase() === w;
  };

  function parseOr(): Expr {
    const items = [parseAnd()];
    while (isWord('or')) {
      next();
      items.push(parseAnd());
    }
    return items.length === 1 ? items[0] : { type: 'or', items };
  }
  function parseAnd(): Expr {
    const items = [parseNot()];
    while (isWord('and')) {
      next();
      items.push(parseNot());
    }
    return items.length === 1 ? items[0] : { type: 'and', items };
  }
  function parseNot(): Expr {
    if (isWord('not')) {
      next();
      return { type: 'not', item: parseNot() };
    }
    return parsePrimary();
  }
  function parsePrimary(): Expr {
    const t = peek();
    if (t.t === 'lparen') {
      next();
      const e = parseOr();
      if (peek().t !== 'rparen') throw new Error(`Expected ")" at column ${peek().pos + 1}`);
      next();
      return e;
    }
    if (t.t !== 'ident' || !FIELD_RE.test(t.v)) {
      throw new Error(`Expected a field name at column ${t.pos + 1}`);
    }
    next();
    const field = t.v;
    const opTok = peek();
    if (opTok.t === 'ident' && opTok.v.toLowerCase() === 'exists') {
      next();
      return { type: 'exists', field };
    }
    let op: CmpOp | undefined;
    if (opTok.t === 'op' && OPERATORS.includes(opTok.v as CmpOp)) op = opTok.v as CmpOp;
    if (opTok.t === 'ident') {
      const word = opTok.v.toLowerCase();
      const found = OPERATORS.find((o) => o.toLowerCase() === word);
      if (found) op = found;
      else if (word === 'includes') op = 'contains';
    }
    if (!op) throw new Error(`Expected an operator after "${field}" at column ${opTok.pos + 1}`);
    next();
    const value = parseLiteral();
    return { type: 'cmp', field, op, value };
  }
  function parseLiteral(): Literal {
    const t = next();
    switch (t.t) {
      case 'string':
        return { kind: 'string', value: t.v };
      case 'number':
        return { kind: 'number', value: t.v };
      case 'regex':
        return { kind: 'regex', source: t.source, flags: t.flags };
      case 'ref':
        return { kind: 'ref', field: t.v };
      case 'ident': {
        const lower = t.v.toLowerCase();
        if (lower === 'true' || lower === 'false') return { kind: 'bool', value: lower === 'true' };
        if (lower === 'null') return { kind: 'null' };
        if (/^\d{4}-\d{2}-\d{2}$/.test(t.v)) return { kind: 'date', ms: localDate(t.v) };
        if (lower === 'today' || lower === 'now') {
          let ms = lower === 'now' ? Date.now() : startOfToday();
          const sign = peek();
          if (sign.t === 'op' && (sign.v === '+' || sign.v === '-')) {
            next();
            const amt = next();
            if (amt.t !== 'ident' || !/^\d+[dwmy]$/i.test(amt.v)) {
              throw new Error(
                `Expected a duration like 7d after "${lower} ${sign.v}" at column ${amt.pos + 1}`
              );
            }
            const n = parseInt(amt.v, 10) * (sign.v === '-' ? -1 : 1);
            ms = shift(ms, n, amt.v[amt.v.length - 1].toLowerCase());
          }
          return { kind: 'date', ms };
        }
        throw new Error(`Unexpected value "${t.v}" at column ${t.pos + 1}. Strings must be quoted`);
      }
      default:
        throw new Error(`Expected a value at column ${t.pos + 1}`);
    }
  }

  const expr = parseOr();
  if (peek().t !== 'eof') {
    throw new Error(`Unexpected "${describe(peek())}" at column ${peek().pos + 1}`);
  }
  return expr;
}

function describe(t: Token): string {
  switch (t.t) {
    case 'ident':
    case 'op':
      return t.v;
    case 'string':
      return `"${t.v}"`;
    case 'number':
      return String(t.v);
    case 'regex':
      return `/${t.source}/`;
    case 'ref':
      return `$.${t.v}`;
    case 'lparen':
      return '(';
    case 'rparen':
      return ')';
    default:
      return 'end';
  }
}

function localDate(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function shift(ms: number, n: number, unit: string): number {
  const d = new Date(ms);
  switch (unit) {
    case 'd':
      d.setDate(d.getDate() + n);
      break;
    case 'w':
      d.setDate(d.getDate() + n * 7);
      break;
    case 'm':
      d.setMonth(d.getMonth() + n);
      break;
    case 'y':
      d.setFullYear(d.getFullYear() + n);
      break;
  }
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Evaluation

export interface FileMeta {
  path: string;
  name: string;
  folder: string;
  modified: number;
  created: number;
  size: number;
}

export interface FileRecord {
  file: FileMeta;
  fm: { [key: string]: unknown };
}

export function resolveField(record: FileRecord, field: string): unknown {
  if (field.startsWith('file.')) {
    const key = field.slice(5) as keyof FileMeta;
    const v = record.file[key];
    return key === 'modified' || key === 'created' ? new Date(v as number) : v;
  }
  const path = field.startsWith('fm.') ? field.slice(3) : field;
  let cur: unknown = record.fm;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as { [k: string]: unknown })[part];
  }
  return cur;
}

/**
 * Evaluates `expr` against `record`. `self` is the file containing the query;
 * `$.field` literals read from it and match when any of its values match.
 */
export function evaluate(expr: Expr, record: FileRecord, self?: FileRecord): boolean {
  switch (expr.type) {
    case 'and':
      return expr.items.every((e) => evaluate(e, record, self));
    case 'or':
      return expr.items.some((e) => evaluate(e, record, self));
    case 'not':
      return !evaluate(expr.item, record, self);
    case 'exists':
      return !isEmpty(resolveField(record, expr.field));
    case 'cmp': {
      const actual = resolveField(record, expr.field);
      if (expr.value.kind !== 'ref') return compare(actual, expr.op, expr.value);
      const lits = refLiterals(self ? resolveField(self, expr.value.field) : undefined);
      // `!=` against a set means "none of them"; everything else means "any of them".
      return expr.op === '!='
        ? lits.every((l) => compare(actual, expr.op, l))
        : lits.some((l) => compare(actual, expr.op, l));
    }
  }
}

/** Whether the expression reads the current file via `$.field`. */
export function usesSelf(expr: Expr): boolean {
  switch (expr.type) {
    case 'and':
    case 'or':
      return expr.items.some(usesSelf);
    case 'not':
      return usesSelf(expr.item);
    case 'exists':
      return false;
    case 'cmp':
      return expr.value.kind === 'ref';
  }
}

/** Converts a frontmatter value into the literal(s) a `$.field` reference stands for. */
function refLiterals(v: unknown): Exclude<Literal, { kind: 'ref' }>[] {
  const one = (x: unknown): Exclude<Literal, { kind: 'ref' }> => {
    if (x === undefined || x === null) return { kind: 'null' };
    if (typeof x === 'number') return { kind: 'number', value: x };
    if (typeof x === 'boolean') return { kind: 'bool', value: x };
    if (x instanceof Date) return { kind: 'date', ms: x.getTime() };
    if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return { kind: 'date', ms: localDate(x) };
    return { kind: 'string', value: typeof x === 'string' ? x : String(x) };
  };
  if (Array.isArray(v)) return v.length ? v.map(one) : [{ kind: 'null' }];
  return [one(v)];
}

/** A field is empty when missing, `null`, `""` or an empty list (e.g. a relation with no items). */
function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Notion semantics: an empty field equals `null`/`""` — `!=` is true, everything else false. */
function compare(actual: unknown, op: CmpOp, lit: Exclude<Literal, { kind: 'ref' }>): boolean {
  const missing = isEmpty(actual);
  if (lit.kind === 'null' || (lit.kind === 'string' && lit.value === '')) {
    return op === '==' ? missing : op === '!=' ? !missing : false;
  }
  if (missing) return op === '!=';

  switch (op) {
    case '==':
      return Array.isArray(actual) ? actual.some((a) => looseEq(a, lit)) : looseEq(actual, lit);
    case '!=':
      return Array.isArray(actual) ? !actual.some((a) => looseEq(a, lit)) : !looseEq(actual, lit);
    case 'contains':
      if (Array.isArray(actual)) return actual.some((a) => looseEq(a, lit) || strIncludes(a, lit));
      return strIncludes(actual, lit);
    case 'startsWith':
    case 'endsWith': {
      const test = (a: unknown) => {
        const s = asString(a);
        const l = litString(lit);
        if (s === undefined || l === undefined) return false;
        return op === 'startsWith' ? s.startsWith(l) : s.endsWith(l);
      };
      return Array.isArray(actual) ? actual.some(test) : test(actual);
    }
    case 'matches': {
      if (lit.kind !== 'regex') return false;
      let re: RegExp;
      try {
        re = new RegExp(lit.source, lit.flags);
      } catch {
        return false;
      }
      const test = (a: unknown) => {
        const s = asString(a);
        return s !== undefined && re.test(s);
      };
      return Array.isArray(actual) ? actual.some(test) : test(actual);
    }
    default: {
      const [a, b] = ordered(actual, lit);
      if (a === undefined || b === undefined) return false;
      switch (op) {
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        case '>=':
          return a >= b;
      }
      return false;
    }
  }
}

function looseEq(actual: unknown, lit: Literal): boolean {
  switch (lit.kind) {
    case 'string':
      return asString(actual) === lit.value;
    case 'number':
      return typeof actual === 'number' ? actual === lit.value : Number(actual) === lit.value;
    case 'bool':
      return actual === lit.value || String(actual).toLowerCase() === String(lit.value);
    case 'date': {
      const ms = asDateMs(actual);
      return ms !== undefined && ms === lit.ms;
    }
    default:
      return false;
  }
}

function strIncludes(actual: unknown, lit: Literal): boolean {
  const s = asString(actual);
  const l = litString(lit);
  return s !== undefined && l !== undefined && s.includes(l);
}

function litString(lit: Literal): string | undefined {
  switch (lit.kind) {
    case 'string':
      return lit.value;
    case 'number':
      return String(lit.value);
    case 'bool':
      return String(lit.value);
    default:
      return undefined;
  }
}

/** Returns a comparable pair (numbers or strings), or undefined when types don't line up. */
function ordered(
  actual: unknown,
  lit: Literal
): [number | string | undefined, number | string | undefined] {
  if (lit.kind === 'date') return [asDateMs(actual), lit.ms];
  if (lit.kind === 'number') {
    const n = typeof actual === 'number' ? actual : Number(actual);
    return [Number.isNaN(n) ? undefined : n, lit.value];
  }
  if (lit.kind === 'string') {
    const ms = asDateMs(actual);
    const litMs = /^\d{4}-\d{2}-\d{2}/.test(lit.value) ? Date.parse(lit.value) : NaN;
    if (ms !== undefined && !Number.isNaN(litMs)) return [ms, litMs];
    return [asString(actual), lit.value];
  }
  return [undefined, undefined];
}

export function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return undefined;
}

export function asDateMs(v: unknown): number | undefined {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return localDate(v);
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** Sort comparator over records for the query's sort spec. Missing values sort last. */
export function compareRecords(query: Query): (a: FileRecord, b: FileRecord) => number {
  return (a, b) => {
    for (const { field, dir } of query.sort) {
      const va = resolveField(a, field);
      const vb = resolveField(b, field);
      const c = compareValues(va, vb);
      if (c !== 0) return dir === 'asc' ? c : -c;
    }
    return a.file.path.localeCompare(b.file.path);
  };
}

export function compareValues(a: unknown, b: unknown): number {
  const am = a === undefined || a === null;
  const bm = b === undefined || b === null;
  if (am && bm) return 0;
  if (am) return 1;
  if (bm) return -1;
  if (a instanceof Date || b instanceof Date) {
    const x = asDateMs(a);
    const y = asDateMs(b);
    if (x !== undefined && y !== undefined) return x - y;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const sa = Array.isArray(a) ? a.map(String).join(', ') : (asString(a) ?? JSON.stringify(a));
  const sb = Array.isArray(b) ? b.map(String).join(', ') : (asString(b) ?? JSON.stringify(b));
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

// ---------------------------------------------------------------------------
// `from` matching

const GLOB_CHARS = /[*?{]/;

/** Turns `from` into a predicate over workspace-relative paths (forward slashes). */
export function fromMatcher(from: string | undefined): (path: string) => boolean {
  if (!from) return () => true;
  let pattern = from.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
  if (!GLOB_CHARS.test(pattern)) pattern = pattern ? `${pattern}/**/*.md` : '**/*.md';
  const re = globToRegExp(pattern);
  return (path) => re.test(path);
}

export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const alts = glob
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'));
        re += `(?:${alts.join('|')})`;
        i = end;
      }
    } else if (/[.+^$()|[\]\\]/.test(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + '$');
}
