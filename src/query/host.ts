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

/** Bytes read from the head of a file to find its frontmatter. */
const HEAD_BYTES = 4096;
const MAX_HEAD_BYTES = 64 * 1024;

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

export class FileIndex implements vscode.Disposable {
  private readonly entries = new Map<string, FileRecord>();
  private building: Promise<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires (debounced) when the index changes after a build. */
  readonly onDidChange = this.changeEmitter.event;
  private changeTimer: NodeJS.Timeout | undefined;

  constructor(readonly folder: vscode.WorkspaceFolder) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*.{md,markdown}')
    );
    watcher.onDidCreate((uri) => this.refresh(uri));
    watcher.onDidChange((uri) => this.refresh(uri));
    watcher.onDidDelete((uri) => this.remove(uri));
    this.disposables.push(watcher, this.changeEmitter);
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
    this.building = this.build();
    await this.building;
    this.emitChange();
  }

  records(): FileRecord[] {
    return [...this.entries.values()];
  }

  record(relPath: string): FileRecord | undefined {
    return this.entries.get(relPath);
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

  private async build(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.folder, '**/*.{md,markdown}'),
      '**/node_modules/**'
    );
    await Promise.all(uris.map((uri) => this.load(uri)));
  }

  private async refresh(uri: vscode.Uri): Promise<void> {
    if (!this.building) return;
    await this.load(uri);
    this.emitChange();
  }

  private remove(uri: vscode.Uri): void {
    if (this.entries.delete(this.relative(uri))) this.emitChange();
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
      const fm = await readFrontmatter(uri.fsPath, stat.size);
      const base = path.posix.basename(rel);
      this.entries.set(rel, {
        file: {
          path: rel,
          name: base.replace(/\.(md|markdown)$/i, ''),
          folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
          modified: stat.mtimeMs,
          created: stat.birthtimeMs || stat.mtimeMs,
          size: stat.size,
        },
        fm,
      });
    } catch {
      this.entries.delete(rel);
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
  source?: RelationSource
): QueryResult | { error: string } {
  const { query, errors } = parseQuery(text);
  if (errors.length) {
    return { error: errors.map((e) => `Line ${e.line + 1}: ${e.message}`).join('\n') };
  }
  const matches = fromMatcher(query.from);
  const filtered = records.filter(
    (r) => matches(r.file.path) && query.where.every((e) => evaluate(e, r))
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
