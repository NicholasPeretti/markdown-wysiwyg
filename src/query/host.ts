/**
 * Extension-host side of query tables: an in-memory index of the workspace's
 * Markdown files (stat + frontmatter) kept fresh by a file watcher, and the
 * query runner over it.
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import YAML from 'yaml';
import {
  compareRecords,
  compareValues,
  effectiveColumns,
  evaluate,
  fromMatcher,
  parseQuery,
  resolveField,
  type FileRecord,
  type Query,
} from './lang';
import type { CompletionContext } from './complete';
import { relationsFor, resolveOption, type Relation, type RelationSource } from './relations';
import { SearchIndex, matchLines, type MatchLine } from './search';

/** Bytes read from the head of a file to find its frontmatter. */
const HEAD_BYTES = 4096;
const MAX_HEAD_BYTES = 64 * 1024;
/** Files larger than this are indexed by frontmatter only, not full text. */
const MAX_TEXT_BYTES = 1024 * 1024;

export type Cell =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'url'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'date'; value: string }
  | { kind: 'array'; value: string[] }
  | { kind: 'object'; value: string }
  | { kind: 'relation'; items: { value: string; label?: string; path?: string }[]; relation: Relation };

export interface QueryResult {
  columns: string[];
  /** `path` is empty for `distinct` rows, which do not stand for a file. */
  rows: { path: string; cells: Cell[] }[];
  total: number;
  /** Present when the query has `group:`; indexes into `rows`, in display order. */
  groups?: { value: Cell; rows: number[] }[];
}

const RECONCILE_MS = 3000;

function isMarkdown(uri: vscode.Uri): boolean {
  return /\.(md|markdown)$/i.test(uri.path);
}

export interface SearchResult {
  path: string;
  name: string;
  title?: string;
  folder: string;
  score: number;
  matches: MatchLine[];
}

export class FileIndex implements vscode.Disposable {
  private readonly entries = new Map<string, FileRecord>();
  private readonly search = new SearchIndex();
  /** Body text of each indexed file and the line it starts on, for snippets. */
  private readonly texts = new Map<string, { body: string; line: number }>();
  private building: Promise<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires (debounced) when the index changes after a build. */
  readonly onDidChange = this.changeEmitter.event;
  private changeTimer: NodeJS.Timeout | undefined;

  constructor(readonly folder: vscode.WorkspaceFolder) {
    // Watch everything, not just `*.md`: when a folder is moved or deleted
    // VS Code only reports the folder, so a markdown-only pattern would
    // never hear about the files inside it.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**'));
    watcher.onDidCreate((uri) => this.onCreated(uri));
    watcher.onDidChange((uri) => (isMarkdown(uri) ? this.refresh(uri) : undefined));
    watcher.onDidDelete((uri) => this.remove(uri));
    this.disposables.push(watcher, this.changeEmitter);
  }

  private lastReconcile = 0;

  /**
   * Re-lists the workspace and fixes any drift (files the watcher missed),
   * at most once per `RECONCILE_MS`. Cheap enough to run before each query.
   */
  async reconcile(force = false): Promise<void> {
    await this.ensure();
    const now = Date.now();
    if (!force && now - this.lastReconcile < RECONCILE_MS) return;
    this.lastReconcile = now;
    const uris = await this.list();
    const seen = new Set<string>();
    const loads: Promise<void>[] = [];
    for (const uri of uris) {
      const rel = this.relative(uri);
      seen.add(rel);
      if (!this.entries.has(rel)) loads.push(this.load(uri));
    }
    let changed = loads.length > 0;
    for (const rel of [...this.entries.keys()]) {
      if (!seen.has(rel)) {
        this.drop(rel);
        changed = true;
      }
    }
    await Promise.all(loads);
    if (changed) this.emitChange();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    clearTimeout(this.changeTimer);
  }

  async ensure(): Promise<void> {
    if (!this.building) this.building = this.build();
    await this.building;
  }

  async rebuild(): Promise<void> {
    this.entries.clear();
    this.search.clear();
    this.texts.clear();
    this.building = this.build();
    await this.building;
    this.emitChange();
  }

  records(): FileRecord[] {
    return [...this.entries.values()];
  }

  /** Stems a query highlights, flattened (for the editor's find bar). */
  searchTerms(query: string): string[] {
    return [...new Set(this.search.queryTerms(query).flat())];
  }

  /** BM25-ranked files for a free-text query, each with its best matching lines. */
  find(query: string, limit = 50): SearchResult[] {
    const groups = this.search.queryTerms(query);
    return this.search.search(query, limit).map(({ id, score }) => {
      const rec = this.entries.get(id)!;
      const title = typeof rec.fm.title === 'string' ? rec.fm.title : undefined;
      return {
        path: id,
        name: rec.file.name,
        title,
        folder: rec.file.folder,
        score,
        matches: this.bodyMatches(id, groups),
      };
    });
  }

  record(relPath: string): FileRecord | undefined {
    return this.entries.get(relPath);
  }

  /**
   * The record for an open document, using `frontmatterText` (the unsaved
   * frontmatter from the editor) in place of what is on disk.
   */
  selfRecord(uri: vscode.Uri, frontmatterText?: string | null): FileRecord {
    const rel = this.relative(uri);
    const indexed = this.entries.get(rel);
    const file = indexed?.file ?? {
      path: rel,
      name: path.basename(rel, path.extname(rel)),
      folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
      modified: 0,
      created: 0,
      size: 0,
    };
    const fm = typeof frontmatterText === 'string' ? parseYaml(frontmatterText) : indexed?.fm ?? {};
    return { file, fm };
  }

  completionContext(): CompletionContext {
    const fields = new Set<string>();
    const values = new Map<string, Set<string>>();
    const folders = new Set<string>();
    for (const rec of this.entries.values()) {
      if (rec.file.folder) {
        const parts = rec.file.folder.split('/');
        for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
      }
      collectFields(rec.fm, '', fields, values);
    }
    const valuesObj: { [k: string]: string[] } = {};
    for (const [k, v] of values) valuesObj[k] = [...v].sort().slice(0, 50);
    return {
      fields: [...fields].sort(),
      values: valuesObj,
      folders: [...folders].sort(),
    };
  }

  private list(): Thenable<vscode.Uri[]> {
    return vscode.workspace.findFiles(
      new vscode.RelativePattern(this.folder, '**/*.{md,markdown}'),
      '**/node_modules/**'
    );
  }

  private async build(): Promise<void> {
    this.lastReconcile = Date.now();
    const uris = await this.list();
    await Promise.all(uris.map((uri) => this.load(uri)));
  }

  private async refresh(uri: vscode.Uri): Promise<void> {
    if (!this.building) return;
    await this.load(uri);
    this.emitChange();
  }

  /** A created path may be a folder moved in: index every markdown file under it. */
  private async onCreated(uri: vscode.Uri): Promise<void> {
    if (!this.building) return;
    if (isMarkdown(uri)) return this.refresh(uri);
    try {
      if (!(await fs.stat(uri.fsPath)).isDirectory()) return;
    } catch {
      return;
    }
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(uri, '**/*.{md,markdown}'),
      '**/node_modules/**'
    );
    if (uris.length === 0) return;
    await Promise.all(uris.map((u) => this.load(u)));
    this.emitChange();
  }

  /** Drops the file, or every file under the path when a folder went away. */
  private remove(uri: vscode.Uri): void {
    const rel = this.relative(uri);
    let changed = this.drop(rel);
    if (!isMarkdown(uri)) {
      const prefix = `${rel}/`;
      for (const key of [...this.entries.keys()]) {
        if (key.startsWith(prefix)) {
          this.drop(key);
          changed = true;
        }
      }
    }
    if (changed) this.emitChange();
  }

  private bodyMatches(rel: string, groups: string[][]): MatchLine[] {
    const entry = this.texts.get(rel);
    if (!entry) return [];
    return matchLines(entry.body, groups).map((m) => ({ ...m, line: m.line + entry.line }));
  }

  private drop(rel: string): boolean {
    this.search.delete(rel);
    this.texts.delete(rel);
    return this.entries.delete(rel);
  }

  private emitChange(): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.changeEmitter.fire(), 150);
  }

  private relative(uri: vscode.Uri): string {
    return path.relative(this.folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
  }

  private async load(uri: vscode.Uri): Promise<void> {
    const rel = this.relative(uri);
    if (rel.startsWith('..') || rel.includes('/.git/') || rel.startsWith('.git/')) return;
    try {
      const stat = await fs.stat(uri.fsPath);
      if (!stat.isFile()) return;
      const base = path.posix.basename(rel);
      const name = base.replace(/\.(md|markdown)$/i, '');
      let fm: { [k: string]: unknown };
      if (stat.size <= MAX_TEXT_BYTES) {
        const text = await fs.readFile(uri.fsPath, 'utf8');
        const split = splitFrontmatter(text);
        fm = split.fm;
        this.texts.set(rel, { body: split.body, line: text.slice(0, text.length - split.body.length).split('\n').length - 1 });
        const title = typeof fm.title === 'string' ? fm.title : '';
        this.search.set(rel, `${name} ${title}`, split.body);
      } else {
        fm = await readFrontmatter(uri.fsPath, stat.size);
        this.texts.delete(rel);
        this.search.delete(rel);
      }
      this.entries.set(rel, {
        file: {
          path: rel,
          name,
          folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
          modified: stat.mtimeMs,
          created: stat.birthtimeMs || stat.mtimeMs,
          size: stat.size,
        },
        fm,
      });
    } catch {
      this.drop(rel);
    }
  }
}

function collectFields(
  obj: unknown,
  prefix: string,
  fields: Set<string>,
  values: Map<string, Set<string>>
): void {
  if (obj === null || typeof obj !== 'object' || obj instanceof Date) return;
  for (const [key, value] of Object.entries(obj as { [k: string]: unknown })) {
    const name = prefix ? `${prefix}.${key}` : key;
    fields.add(name);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      collectFields(value, name, fields, values);
      continue;
    }
    const scalars = Array.isArray(value) ? value : [value];
    for (const s of scalars) {
      if (s === null || s === undefined || typeof s === 'object') continue;
      const str = String(s);
      if (str.length > 60) continue;
      let set = values.get(name);
      if (!set) values.set(name, (set = new Set()));
      if (set.size < 50) set.add(str);
    }
  }
}

/** Frontmatter object and the Markdown body of a whole file's text. */
function splitFrontmatter(text: string): { fm: { [k: string]: unknown }; body: string } {
  if (!/^\uFEFF?---[ \t]*\r?\n/.test(text)) return { fm: {}, body: text };
  const close = /\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text.slice(4));
  if (!close) return { fm: {}, body: text };
  const yamlText = text.slice(text.indexOf('\n') + 1, 4 + close.index);
  const body = text.slice(4 + close.index + close[0].length);
  return { fm: parseYaml(yamlText), body };
}

async function readFrontmatter(file: string, size: number): Promise<{ [k: string]: unknown }> {
  if (size === 0) return {};
  const handle = await fs.open(file, 'r');
  try {
    let length = Math.min(HEAD_BYTES, size);
    let text = '';
    for (;;) {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, 0);
      text = buf.subarray(0, bytesRead).toString('utf8');
      if (!/^\uFEFF?---[ \t]*\r?\n/.test(text)) return {};
      const close = /\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text.slice(4));
      if (close) {
        const yamlText = text.slice(text.indexOf('\n') + 1, 4 + close.index);
        return parseYaml(yamlText);
      }
      if (length >= size || length >= MAX_HEAD_BYTES) return {};
      length = Math.min(length * 4, size, MAX_HEAD_BYTES);
    }
  } finally {
    await handle.close();
  }
}

function parseYaml(text: string): { [k: string]: unknown } {
  try {
    const value = YAML.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------

export function runQuery(
  text: string,
  records: FileRecord[],
  source?: RelationSource,
  self?: FileRecord
): QueryResult | { error: string } {
  const { query, errors } = parseQuery(text);
  if (errors.length) {
    return { error: errors.map((e) => `Line ${e.line + 1}: ${e.message}`).join('\n') };
  }
  const matches = fromMatcher(query.from);
  const filtered = records.filter(
    (r) => matches(r.file.path) && query.where.every((e) => evaluate(e, r, self))
  );
  if (query.distinct) return runDistinct(query, filtered);

  filtered.sort(compareRecords(query));
  const columns = effectiveColumns(query);
  const limited = filtered.slice(0, query.limit);
  const rows = limited.map((r) => {
    const rels = source ? relationsFor(source, r.file.path) : undefined;
    return {
      path: r.file.path,
      cells: columns.map((c) => {
        const rel = rels?.get(c);
        const v = resolveField(r, c);
        return rel && source ? relationCell(source, rel, v) : toCell(v);
      }),
    };
  });
  if (!query.group) return { columns, rows, total: filtered.length };

  // Group the limited rows; a file with an array value lands in every group.
  const field = query.group;
  const buckets = new Map<string, { value: unknown; rows: number[] }>();
  limited.forEach((r, i) => {
    const raw = resolveField(r, field);
    const values = Array.isArray(raw) && raw.length ? raw : [raw];
    for (const v of values) {
      const k = groupKey(v);
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = { value: v, rows: [] }));
      b.rows.push(i);
    }
  });
  const dir = query.sort.find((s) => s.field === field)?.dir ?? 'asc';
  const groups = [...buckets.values()]
    .sort((a, b) => {
      const c = compareValues(a.value, b.value);
      return dir === 'asc' ? c : -c;
    })
    .map((b) => ({ value: toCell(b.value), rows: b.rows }));
  return { columns, rows, total: filtered.length, groups };
}

function runDistinct(query: Query, filtered: FileRecord[]): QueryResult {
  const field = query.distinct!;
  const buckets = new Map<string, { value: unknown; count: number }>();
  for (const r of filtered) {
    const raw = resolveField(r, field);
    const values = Array.isArray(raw) && raw.length ? raw : [raw];
    for (const v of new Set(values.map((x) => (x instanceof Date ? x.toISOString() : x)))) {
      const k = groupKey(v);
      const b = buckets.get(k);
      if (b) b.count++;
      else buckets.set(k, { value: v, count: 1 });
    }
  }
  const sort = query.sort[0];
  const byCount = sort.field === 'count';
  const list = [...buckets.values()].sort((a, b) => {
    const c = byCount ? a.count - b.count : compareValues(a.value, b.value);
    const d = sort.dir === 'asc' ? c : -c;
    return d !== 0 ? d : compareValues(a.value, b.value);
  });
  const rows = list.slice(0, query.limit).map((b) => ({
    path: '',
    cells: [toCell(b.value), { kind: 'number', value: b.count } as Cell],
  }));
  return { columns: [field, 'count'], rows, total: list.length };
}

function groupKey(v: unknown): string {
  if (v === undefined || v === null) return '\u0000null';
  if (v instanceof Date) return `d:${v.toISOString()}`;
  if (typeof v === 'object') return `o:${JSON.stringify(v)}`;
  return `${typeof v}:${String(v)}`;
}

function relationCell(source: RelationSource, rel: Relation, v: unknown): Cell {
  if (v === undefined || v === null) return { kind: 'relation', items: [], relation: rel };
  const values = Array.isArray(v) ? v : [v];
  return {
    kind: 'relation',
    relation: rel,
    items: values
      .filter((x) => x !== null && x !== undefined && typeof x !== 'object')
      .map((x) => {
        const opt = resolveOption(source, rel, String(x));
        return { value: String(x), path: opt?.path, ...(opt && opt.label !== String(x) ? { label: opt.label } : {}) };
      }),
  };
}

function toCell(v: unknown): Cell {
  if (v === undefined || v === null) return { kind: 'null' };
  if (v instanceof Date) return { kind: 'date', value: v.toISOString() };
  if (typeof v === 'boolean') return { kind: 'bool', value: v };
  if (typeof v === 'number') return { kind: 'number', value: v };
  if (typeof v === 'string') {
    if (/^https?:\/\/\S+$/i.test(v)) return { kind: 'url', value: v };
    return { kind: 'string', value: v };
  }
  if (Array.isArray(v)) {
    return { kind: 'array', value: v.map((x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x))) };
  }
  return { kind: 'object', value: JSON.stringify(v) };
}
