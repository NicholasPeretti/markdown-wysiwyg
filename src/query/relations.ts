/**
 * Relations between "databases" (folders), Notion-style. A file declares in
 * its own frontmatter which of its fields are relations, under the reserved
 * `$relations` key:
 *
 *   $relations:
 *     tags:
 *       from: tags
 *       field: name
 *       multi: true
 *     status:
 *       from: statuses
 *       field: name
 *
 * `from` is the folder holding the options (workspace-relative, or `./x`
 * relative to the file), `field` the frontmatter field of an option file
 * whose value is stored (default: the option's file name), and `multi`
 * whether the field holds a list (default: single value, shown as a
 * dropdown). Declared fields appear in the properties panel even when the
 * file has no value for them yet.
 */

import type { FileRecord } from './lang';

export interface Relation {
  /** Workspace-relative folder holding the options, without trailing slash. */
  folder: string;
  /** Frontmatter field of option files that provides the stored value. */
  field?: string;
  multi: boolean;
}

export interface RelationOption {
  value: string;
  label: string;
  path: string;
  /** The linked file's `$colour`, which tints its pills. */
  colour?: Colour;
}

/** Values `$colour` accepts; anything else leaves the pill untinted. */
export const COLOURS = ['gray', 'yellow', 'orange', 'blue', 'green', 'purple', 'pink', 'red'] as const;
export type Colour = (typeof COLOURS)[number];

/** Reserved frontmatter key a linked file sets to tint the pills pointing to it. */
export const COLOUR_KEY = '$colour';

export interface RelationSource {
  record(relPath: string): FileRecord | undefined;
  records(): FileRecord[];
}

const INDEX_NAMES = ['index.md', 'README.md', 'readme.md', 'index.markdown'];

/** Reserved frontmatter key holding the relation declarations. */
export const RELATIONS_KEY = '$relations';

/** Relations declared by the file at `relPath` (field → relation). */
export function relationsFor(source: RelationSource, relPath: string): Map<string, Relation> {
  const rec = source.record(relPath);
  return rec ? parseRelations(rec.fm[RELATIONS_KEY], dirname(relPath)) : new Map();
}

/** Parses a `relations:` frontmatter value; `base` resolves `./` folders. */
export function parseRelations(value: unknown, base: string): Map<string, Relation> {
  const out = new Map<string, Relation>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [field, spec] of Object.entries(value as { [k: string]: unknown })) {
    let folder: unknown;
    let multi = false;
    let valueField: string | undefined;
    if (typeof spec === 'string') {
      folder = spec;
    } else if (spec && typeof spec === 'object') {
      const o = spec as { [k: string]: unknown };
      folder = o.from ?? o.folder;
      multi = o.multi === true;
      if (typeof o.field === 'string' && o.field.trim()) valueField = o.field.trim();
    }
    if (typeof folder !== 'string') continue;
    out.set(field, { folder: normalizeFolder(folder, base), field: valueField, multi });
  }
  return out;
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Resolves `./x` against `base`; other paths are workspace-relative. */
export function normalizeFolder(folder: string, base: string): string {
  let f = folder.trim().replace(/\\/g, '/');
  if (f.startsWith('./') || f.startsWith('../')) f = `${base}/${f}`;
  const out: string[] = [];
  for (const seg of f.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/** Cache key for a relation's option set. */
export function relationKey(rel: Relation): string {
  return `${rel.folder}|${rel.field ?? ''}`;
}

/** Files in the relation's folder (recursively), excluding its index, as options. */
export function optionsFor(source: RelationSource, rel: Relation): RelationOption[] {
  const prefix = rel.folder ? `${rel.folder}/` : '';
  const out: RelationOption[] = [];
  for (const rec of source.records()) {
    const p = rec.file.path;
    if (!p.startsWith(prefix)) continue;
    if (INDEX_NAMES.includes(p.slice(prefix.length))) continue;
    const value = optionValue(rec, rel);
    if (value === undefined) continue;
    out.push(option(rec, value));
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

function optionValue(rec: FileRecord, rel: Relation): string | undefined {
  if (!rel.field) return rec.file.name;
  const v = rec.fm[rel.field];
  if (v === null || v === undefined || typeof v === 'object') return undefined;
  const s = String(v).trim();
  return s || undefined;
}

function option(rec: FileRecord, value: string): RelationOption {
  const raw = rec.fm[COLOUR_KEY];
  const colour = typeof raw === 'string' ? raw.trim().toLowerCase() : undefined;
  const opt: RelationOption = { value, label: optionLabel(rec, value), path: rec.file.path };
  if (colour && (COLOURS as readonly string[]).includes(colour)) opt.colour = colour as Colour;
  return opt;
}

function optionLabel(rec: FileRecord, value: string): string {
  const title = rec.fm.title;
  return typeof title === 'string' && title.trim() ? title : value;
}

/** Resolves a stored value to its option (path + label), if it exists. */
export function resolveOption(source: RelationSource, rel: Relation, value: string): RelationOption | undefined {
  if (!rel.field) {
    const base = rel.folder ? `${rel.folder}/` : '';
    for (const ext of ['.md', '.markdown']) {
      const rec = source.record(`${base}${value}${ext}`);
      if (rec) return option(rec, value);
    }
  }
  return optionsFor(source, rel).find((o) => o.value === value);
}
