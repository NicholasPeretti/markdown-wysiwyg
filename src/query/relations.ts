/**
 * Relations between "databases" (folders), Notion-style. A folder's
 * `index.md` declares in its frontmatter which fields of the files in that
 * folder (recursively) point at another folder:
 *
 *   relations:
 *     tags: tags/                     # multi-valued, options = files in tags/
 *     owner: { from: people/, single: true }
 *
 * Values stored in frontmatter are the target files' names (without .md), so
 * the markdown stays portable.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { FileRecord } from './lang';

export interface Relation {
  /** Workspace-relative folder holding the options, without trailing slash. */
  folder: string;
  single: boolean;
}

export interface RelationOption {
  value: string;
  label: string;
  path: string;
}

export interface RelationSource {
  record(relPath: string): FileRecord | undefined;
  records(): FileRecord[];
}

const INDEX_NAMES = ['index.md', 'README.md', 'readme.md', 'index.markdown'];

/** Relations that apply to `relPath`, nearest `index.md` winning per field. */
export function relationsFor(source: RelationSource, relPath: string): Map<string, Relation> {
  const result = new Map<string, Relation>();
  const parts = path.posix.dirname(relPath).split('/').filter((p) => p && p !== '.');
  // Walk from the root down so deeper declarations override shallower ones.
  for (let depth = 0; depth <= parts.length; depth++) {
    const folder = parts.slice(0, depth).join('/');
    for (const name of INDEX_NAMES) {
      const rec = source.record(folder ? `${folder}/${name}` : name);
      if (!rec) continue;
      for (const [field, rel] of parseRelations(rec.fm.relations, folder)) result.set(field, rel);
      break;
    }
  }
  return result;
}

function parseRelations(value: unknown, base: string): [string, Relation][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: [string, Relation][] = [];
  for (const [field, spec] of Object.entries(value as { [k: string]: unknown })) {
    let folder: unknown;
    let single = false;
    if (typeof spec === 'string') {
      folder = spec;
    } else if (spec && typeof spec === 'object') {
      const o = spec as { [k: string]: unknown };
      folder = o.from ?? o.folder ?? o.target;
      single = o.single === true;
    }
    if (typeof folder !== 'string') continue;
    out.push([field, { folder: normalizeFolder(folder, base), single }]);
  }
  return out;
}

/** Resolves `./x` against the declaring folder; other paths are workspace-relative. */
function normalizeFolder(folder: string, base: string): string {
  let f = folder.trim().replace(/\\/g, '/');
  if (f.startsWith('./') || f.startsWith('../')) f = path.posix.join(base, f);
  f = f.replace(/^\/+|\/+$/g, '');
  return f === '.' ? '' : f;
}

/** Files in `folder` (recursively), excluding its own index, as options. */
export function optionsFor(source: RelationSource, folder: string): RelationOption[] {
  const prefix = folder ? `${folder}/` : '';
  const out: RelationOption[] = [];
  for (const rec of source.records()) {
    const p = rec.file.path;
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (INDEX_NAMES.includes(rest)) continue;
    const title = rec.fm.title;
    out.push({
      value: rec.file.name,
      label: typeof title === 'string' && title.trim() ? title : rec.file.name,
      path: p,
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/** Display label for an option file: its `title` frontmatter or file name. */
export function labelFor(source: RelationSource, path: string): string | undefined {
  const rec = source.record(path);
  if (!rec) return undefined;
  const title = rec.fm.title;
  return typeof title === 'string' && title.trim() ? title : rec.file.name;
}

/** Target file for a stored relation value, if the option exists. */
export function targetPath(source: RelationSource, rel: Relation, value: string): string | undefined {
  const base = rel.folder ? `${rel.folder}/` : '';
  for (const ext of ['.md', '.markdown']) {
    const p = `${base}${value}${ext}`;
    if (source.record(p)) return p;
  }
  // Nested option (value may contain a sub-folder) or a title match.
  return optionsFor(source, rel.folder).find((o) => o.value === value || o.label === value)?.path;
}

/** Creates `folder/name.md` for a new option unless it already exists. */
export async function createOption(root: vscode.Uri, folder: string, name: string): Promise<string> {
  const safe = name.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!safe) throw new Error('Option name cannot be empty');
  const rel = `${folder ? `${folder}/` : ''}${safe}.md`;
  const uri = vscode.Uri.joinPath(root, rel);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`# ${name.trim()}\n`, 'utf8'));
  }
  return safe;
}
