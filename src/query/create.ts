/**
 * Creating a workspace file from a query table's "+ New" row. The file gets
 * the frontmatter the query needs to match it, an empty value for every
 * other column, and the `$relations` its siblings declare, so the new row
 * shows up in the table with every cell editable.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import YAML from 'yaml';
import type { FileIndex } from './host';
import { effectiveColumns, fromMatcher, newFileFolder, parseQuery, resolveField, seedValues, validateName, type FileRecord } from './lang';
import { RELATIONS_KEY, parseRelations, type Relation } from './relations';

export interface NewFileContext {
  /** Workspace-relative folder, `''` for the root. */
  folder: string;
  /** Names (without extension) of the markdown files already in `folder`. */
  names: string[];
}

/** Where a file created from `text` would go, or `undefined` when the query cannot create files. */
export function newFileContext(index: FileIndex, docUri: vscode.Uri, text: string): NewFileContext | undefined {
  const { query, errors } = parseQuery(text);
  if (errors.length) return undefined;
  const folder = targetFolder(index, docUri, query);
  if (folder === undefined) return undefined;
  const names = index
    .records()
    .filter((r) => r.file.folder === folder)
    .map((r) => r.file.name);
  return { folder, names };
}

/** Creates the file and returns its workspace-relative path. */
export async function createQueryFile(
  index: FileIndex,
  docUri: vscode.Uri,
  text: string,
  name: string,
  frontmatterText: string | null,
  seed?: GroupSeed
): Promise<string> {
  const { query, errors } = parseQuery(text);
  if (errors.length) throw new Error('The query has errors');
  const folder = targetFolder(index, docUri, query);
  if (folder === undefined) throw new Error('This query cannot create files');
  const context = newFileContext(index, docUri, text)!;
  const problem = validateName(name, context.names);
  if (problem) throw new Error(problem);

  const stem = name.trim().replace(/\.md$/i, '');
  const rel = `${folder ? `${folder}/` : ''}${stem}.md`;
  const uri = vscode.Uri.joinPath(index.folder.uri, rel);
  if (await exists(uri)) throw new Error(`A file "${stem}.md" already exists at this location.`);

  const self = index.selfRecord(docUri, frontmatterText);
  const siblings = siblingRecords(index, query, folder);
  const fm = buildFrontmatter(query, self, siblings, folder, seed);
  const body = fm ? `---\n${fm}---\n` : '';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(body, 'utf8'));
  return rel;
}

function targetFolder(index: FileIndex, docUri: vscode.Uri, query: ReturnType<typeof parseQuery>['query']): string | undefined {
  const folder = newFileFolder(query);
  if (folder !== null) return folder;
  const rel = path.posix.dirname(path.relative(index.folder.uri.fsPath, docUri.fsPath).split(path.sep).join('/'));
  return rel === '.' ? '' : rel;
}

/** Files the query matches, preferring those in the target folder, as a model for the new one. */
function siblingRecords(index: FileIndex, query: ReturnType<typeof parseQuery>['query'], folder: string): FileRecord[] {
  const matches = fromMatcher(query.from);
  const all = index.records().filter((r) => matches(r.file.path));
  const same = all.filter((r) => r.file.folder === folder);
  return same.length ? same : all;
}

/** The group a file is created from: its field gets the group's value. */
export interface GroupSeed {
  field: string;
  value: string | number | boolean;
}

function buildFrontmatter(
  query: ReturnType<typeof parseQuery>['query'],
  self: FileRecord,
  siblings: FileRecord[],
  folder: string,
  seed?: GroupSeed
): string {
  const doc = new YAML.Document({});
  const seeds = seedValues(query, self);
  for (const [field, value] of seeds) {
    const node = doc.createNode(value);
    if (YAML.isSeq(node)) node.flow = true;
    doc.setIn(field.split('.'), node);
  }

  // Relations declared by a sibling apply to the new file too.
  const declared = siblings.find((r) => r.fm[RELATIONS_KEY] && typeof r.fm[RELATIONS_KEY] === 'object');
  const relations = declared
    ? parseRelations(declared.fm[RELATIONS_KEY], path.posix.dirname(declared.file.path))
    : new Map<string, Relation>();

  if (seed && !seed.field.startsWith('file.') && !seeds.has(seed.field)) {
    const rel = relations.get(seed.field);
    const list = rel ? rel.multi : siblings.some((r) => Array.isArray(resolveField(r, seed.field)));
    const node = doc.createNode(list ? [seed.value] : seed.value);
    if (YAML.isSeq(node)) node.flow = true;
    doc.setIn(seed.field.split('.'), node);
    seeds.set(seed.field, seed.value);
  }

  for (const column of effectiveColumns(query)) {
    if (column.startsWith('file.') || column === 'count') continue;
    const field = column.replace(/^fm\./, '');
    if (seeds.has(field)) continue;
    const keyPath = field.split('.');
    if (doc.hasIn(keyPath)) continue;
    const rel = relations.get(field);
    const list = rel ? rel.multi : siblings.some((r) => Array.isArray(resolveField(r, field)));
    if (list) {
      const node = doc.createNode([]);
      node.flow = true;
      doc.setIn(keyPath, node);
    } else {
      doc.setIn(keyPath, null);
    }
  }
  if (declared && relations.size) {
    if (declared.file.folder === folder) {
      doc.setIn([RELATIONS_KEY], JSON.parse(JSON.stringify(declared.fm[RELATIONS_KEY])));
    } else {
      // `./x` folders in the sibling's declaration would resolve differently from here.
      const resolved: { [k: string]: unknown } = {};
      for (const [field, r] of relations) {
        resolved[field] = { from: r.folder, ...(r.field ? { field: r.field } : {}), ...(r.multi ? { multi: true } : {}) };
      }
      doc.setIn([RELATIONS_KEY], resolved);
    }
  }
  if (!YAML.isMap(doc.contents) || doc.contents.items.length === 0) return '';
  return doc.toString({ nullStr: '', flowCollectionPadding: false, lineWidth: 0 });
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
