/**
 * Context-aware completions for the `query` language. Pure; the caller
 * supplies what the index knows (fields, values, folders).
 */

import { AGGREGATES, FILE_FIELDS, OPERATORS, QUERY_KEYS } from './lang';

export interface CompletionContext {
  /** Frontmatter keys seen in the index (dotted for nested). */
  fields: string[];
  /** Distinct scalar values per field, for `==`-style completions. */
  values: { [field: string]: string[] };
  /** Folders (workspace-relative) that contain Markdown files. */
  folders: string[];
  /** Relation field name → frontmatter keys seen in the files it points to. */
  relationFields?: { [field: string]: string[] };
}

const AGGREGATE_DETAIL: { [k: string]: string } = {
  count: 'number of items, e.g. count(tasks)',
  sum: 'sum of numbers',
  avg: 'average of numbers',
  min: 'smallest value',
  max: 'largest value',
};

/** `tasks.` / `parent*.` → the fields of the linked files. */
function relatedFields(word: string, ctx: CompletionContext): CompletionItem[] | null {
  const dot = word.lastIndexOf('.');
  if (dot < 0 || word.startsWith('$') || word.startsWith('file.')) return null;
  const prefix = word.slice(0, dot);
  const open = prefix.lastIndexOf('(');
  const path = prefix.slice(open + 1);
  const last = path.split('.').pop()!.replace(/[*+]$/, '');
  const known = ctx.relationFields?.[last];
  if (!known) return null;
  const items: CompletionItem[] = [
    ...known.map((f) => ({ label: `${prefix}.${f}`, kind: 'field' as const, detail: `${last} → ${f}` })),
    ...FILE_FIELDS.map((f) => ({ label: `${prefix}.${f}`, kind: 'field' as const, detail: FILE_FIELD_DETAIL[f] })),
  ];
  if (!/[*+]$/.test(path.split('.').pop()!) && ctx.relationFields?.[last]) {
    items.push(
      { label: `${prefix}*.`, kind: 'field', detail: `${last} chain, including this file` },
      { label: `${prefix}+.`, kind: 'field', detail: `${last} chain, excluding this file` }
    );
  }
  return items;
}

export interface CompletionItem {
  label: string;
  /** Text to insert; defaults to label. */
  insert?: string;
  kind: 'key' | 'field' | 'operator' | 'value' | 'folder' | 'keyword';
  detail?: string;
}

export interface Completions {
  /** Column where the replaced word starts. */
  from: number;
  items: CompletionItem[];
}

const KEY_DETAIL: { [k: string]: string } = {
  from: 'folder or glob to search',
  where: 'filter expression',
  sort: 'comma-separated field asc|desc',
  limit: 'max rows',
  columns: 'comma-separated fields',
  page_size: 'rows per page (pager in the header)',
  group: 'field to group rows by',
  distinct: 'field whose unique values to list',
};

const FILE_FIELD_DETAIL: { [k: string]: string } = {
  'file.path': 'workspace-relative path',
  'file.name': 'file name without .md',
  'file.folder': 'parent folder',
  'file.modified': 'last modified (mtime)',
  'file.created': 'created (birthtime)',
  'file.size': 'size in bytes',
};

export function complete(line: string, column: number, ctx: CompletionContext): Completions | null {
  const before = line.slice(0, column);
  const wordMatch = /[\w.\-/*+{}?"'$]*$/.exec(before);
  const word = wordMatch ? wordMatch[0] : '';
  const from = column - word.length;

  const keyMatch = /^\s*([A-Za-z_]*)(\s*:\s*)?(.*)$/.exec(before);
  if (!keyMatch) return null;
  const [, key, colon, rest] = keyMatch;

  // Line start: offer keys.
  if (!colon) {
    return {
      from: before.length - key.length,
      items: QUERY_KEYS.map((k) => ({ label: k, insert: `${k}: `, kind: 'key', detail: KEY_DETAIL[k] })),
    };
  }

  const fields = () =>
    relatedFields(word, ctx) ?? [
      ...FILE_FIELDS.map((f) => ({ label: f, kind: 'field' as const, detail: FILE_FIELD_DETAIL[f] })),
      ...ctx.fields.map((f) => ({ label: f, kind: 'field' as const, detail: 'frontmatter' })),
      ...AGGREGATES.map((f) => ({ label: `${f}(`, kind: 'field' as const, detail: AGGREGATE_DETAIL[f] })),
    ];

  switch (key.toLowerCase()) {
    case 'from':
      return { from, items: ctx.folders.map((f) => ({ label: f, kind: 'folder' })) };

    case 'columns': {
      // Complete the last comma-separated entry.
      return { from, items: fields() };
    }

    case 'group':
    case 'distinct':
      return { from, items: fields() };

    case 'sort': {
      // Complete the last comma-separated term.
      const parts = rest.slice(rest.lastIndexOf(',') + 1).trimStart().split(/\s+/);
      if (parts.length <= 1) {
        return { from, items: [{ label: 'count', kind: 'field', detail: 'files per value (with distinct)' }, ...fields()] };
      }
      return {
        from,
        items: [
          { label: 'asc', kind: 'keyword' },
          { label: 'desc', kind: 'keyword' },
        ],
      };
    }

    case 'where':
      return completeWhere(rest, from, word, ctx, fields);

    default:
      return null;
  }
}

function completeWhere(
  expr: string,
  from: number,
  word: string,
  ctx: CompletionContext,
  fields: () => CompletionItem[]
): Completions | null {
  // Tokenise loosely what is before the word being typed.
  const head = expr.slice(0, expr.length - word.length);
  const tokens =
    head.match(
      /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\]|\\.)*\/[a-z]*|[<>=!]+|[\w.\-$*+]+|[()]/g
    ) ?? [];
  // Fold `count ( tasks )` into one field token.
  if (
    tokens.length >= 4 &&
    tokens[tokens.length - 1] === ')' &&
    tokens[tokens.length - 3] === '(' &&
    (AGGREGATES as readonly string[]).includes(tokens[tokens.length - 4].toLowerCase()) &&
    isField(tokens[tokens.length - 2])
  ) {
    tokens.splice(-4, 4, `${tokens[tokens.length - 4]}(${tokens[tokens.length - 2]})`);
  }
  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  const lastLower = last?.toLowerCase();

  const isConnector = (t: string | undefined) =>
    t === undefined || ['and', 'or', 'not', '('].includes(t.toLowerCase());
  const isOperator = (t: string | undefined) =>
    t !== undefined &&
    (t.toLowerCase() === 'includes' || OPERATORS.some((o) => o.toLowerCase() === t.toLowerCase()));
  const connectors: CompletionItem[] = [
    { label: 'and', kind: 'keyword' },
    { label: 'or', kind: 'keyword' },
  ];

  // Start of a clause: field names (and `not`).
  if (isConnector(last)) {
    return { from, items: [...fields(), { label: 'not', kind: 'keyword' }] };
  }

  // After a field: operators.
  if (isField(last) && !isOperator(prev)) {
    return {
      from,
      items: [
        ...OPERATORS.map((o) => ({ label: o, kind: 'operator' as const })),
        { label: 'exists', kind: 'operator' },
      ],
    };
  }

  // After an operator: values for that field.
  if (isOperator(last) && isField(prev)) {
    const field = prev as string;
    // `$.field`: the current file's own frontmatter value.
    if (word.startsWith('$')) {
      return {
        from,
        items: ctx.fields.map((f) => ({ label: `$.${f}`, kind: 'value', detail: 'this file' })),
      };
    }
    const quoted = word.startsWith('"') || word.startsWith("'");
    const items: CompletionItem[] = [];
    for (const v of ctx.values[field] ?? []) {
      const bare = /^(true|false|null|\d+(\.\d+)?|\d{4}-\d{2}-\d{2})$/.test(v);
      items.push({
        label: v,
        insert: quoted ? v.replace(/"/g, '\\"') : bare ? v : JSON.stringify(v),
        kind: 'value',
      });
    }
    const dateField = /^file\.(modified|created)$|date|time|due|at$/i.test(field);
    if (!quoted && items.length === 0 && !dateField) {
      items.push(
        { label: 'true', kind: 'value' },
        { label: 'false', kind: 'value' },
        { label: 'null', kind: 'value' }
      );
    }
    if (!quoted && dateField) {
      items.push(
        { label: 'today', kind: 'keyword' },
        { label: 'now', kind: 'keyword' },
        { label: 'today - 7d', kind: 'keyword' },
        { label: 'now - 30d', kind: 'keyword' }
      );
    }
    if (!quoted && !field.startsWith('file.')) {
      const self = field.startsWith('fm.') ? field.slice(3) : field;
      items.push({ label: `$.${self}`, kind: 'value', detail: 'this file' });
    }
    return items.length ? { from: quoted ? from + 1 : from, items } : null;
  }

  // After a complete clause (literal, `exists`, `)`): connectors.
  if (lastLower === 'exists' || last === ')' || isLiteral(last)) {
    return { from, items: connectors };
  }
  return null;
}

function isField(t: string | undefined): boolean {
  if (t === undefined) return false;
  const path = /^[a-z_][\w-]*[*+]?(\.[a-z_][\w-]*[*+]?)*$/i;
  const call = /^[a-z]+\((.*)\)$/i.exec(t);
  if (call) return (AGGREGATES as readonly string[]).includes(t.slice(0, t.indexOf('(')).toLowerCase()) && path.test(call[1]);
  return path.test(t) && !['and', 'or', 'not', 'exists', 'true', 'false', 'null', 'today', 'now'].includes(t.toLowerCase());
}

function isLiteral(t: string | undefined): boolean {
  return t !== undefined && (/^["'/$]/.test(t) || /^(true|false|null|today|now|\d)/.test(t));
}
