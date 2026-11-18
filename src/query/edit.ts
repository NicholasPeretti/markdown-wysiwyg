/**
 * In-place edits requested from a query table: set a frontmatter field of a
 * workspace file, or rename the file. Edits go through the open text buffer
 * when there is one, so unsaved changes are never clobbered.
 */

import * as vscode from 'vscode';
import type { Relation } from './relations';
import * as path from 'path';
import YAML from 'yaml';

const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export type EditKind = 'null' | 'string' | 'url' | 'number' | 'bool' | 'date' | 'array' | 'object';

/**
 * Sets (or, for an empty value, removes) `field` in the frontmatter of `uri`.
 * `kind` is the kind of the value being replaced and guides coercion of the
 * typed text: strings stay strings, everything else is read as a YAML scalar,
 * and arrays accept comma-separated items.
 */
export async function setFrontmatterField(
  uri: vscode.Uri,
  field: string,
  raw: string,
  kind: EditKind
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const wasDirty = document.isDirty;
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  let change: FrontmatterChange | null;
  try {
    change = rewriteFrontmatter(document.getText(), field, raw, kind, eol);
  } catch (err) {
    throw new Error(`Frontmatter of ${path.basename(uri.fsPath)}: ${err instanceof Error ? err.message : err}`);
  }
  if (!change) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error('Could not apply the edit');
  }
  if (!wasDirty) {
    await document.save();
  }
}

/** Sets `field` to an already-typed `value` (`undefined` removes it). */
export async function setFrontmatterValue(uri: vscode.Uri, field: string, value: unknown): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const wasDirty = document.isDirty;
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const change = rewriteFrontmatterValue(document.getText(), field, value, eol);
  if (!change) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error('Could not apply the edit');
  }
  if (!wasDirty) {
    await document.save();
  }
}

export interface FrontmatterChange {
  start: number;
  end: number;
  text: string;
}

/**
 * Computes the replacement that sets `field` in the frontmatter of `text`,
 * creating or removing the block as needed. Pure, so it is easy to test.
 */
export function rewriteFrontmatter(
  text: string,
  field: string,
  raw: string,
  kind: EditKind,
  eol = '\n'
): FrontmatterChange | null {
  return rewriteFrontmatterValue(text, field, coerce(raw, kind), eol);
}

export function rewriteFrontmatterValue(
  text: string,
  field: string,
  value: unknown,
  eol = '\n'
): FrontmatterChange | null {
  const match = FRONTMATTER_RE.exec(text);
  const yamlText = match?.[1] ?? '';

  const doc: YAML.Document = YAML.parseDocument(yamlText);
  if (doc.errors.length) {
    throw new Error('not valid YAML');
  }
  if (!YAML.isMap(doc.contents)) {
    doc.contents = doc.createNode({});
  }

  const keyPath = field.split('.');
  if (value === undefined) {
    if (!doc.hasIn(keyPath)) return null;
    doc.deleteIn(keyPath);
  } else {
    const previous = doc.getIn(keyPath, true);
    const node = doc.createNode(value);
    // Keep `[a, b]` style arrays inline.
    if (YAML.isSeq(previous) && previous.flow && YAML.isSeq(node)) node.flow = true;
    doc.setIn(keyPath, node);
  }

  const isEmpty = YAML.isMap(doc.contents) && doc.contents.items.length === 0;
  const body = doc.toString({ flowCollectionPadding: false, lineWidth: 0 }).replace(/\n/g, eol);
  if (match) {
    let end = match[0].length;
    if (isEmpty) {
      // Also swallow the blank line that separated the frontmatter from the body.
      end += (/^(\r?\n)+/.exec(text.slice(end))?.[0] ?? '').length;
    }
    return { start: 0, end, text: isEmpty ? '' : `---${eol}${body}---${eol}` };
  }
  if (isEmpty) return null;
  const bom = text.startsWith('\uFEFF') ? 1 : 0;
  return { start: bom, end: bom, text: `---${eol}${body}---${eol}${text.length > bom ? eol : ''}` };
}

/** Renames `uri` to `name` (without extension) in the same folder. */
export async function renameMarkdownFile(uri: vscode.Uri, name: string): Promise<vscode.Uri> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('File name cannot be empty');
  if (/[\\/]/.test(trimmed)) throw new Error('File name cannot contain path separators');
  const ext = path.extname(uri.fsPath);
  const target = vscode.Uri.joinPath(uri, '..', trimmed + ext);
  if (target.toString() === uri.toString()) return uri;
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(uri, target, { overwrite: false, ignoreIfExists: false });
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error(`Could not rename to ${trimmed}${ext} (does it already exist?)`);
  }
  return target;
}

/** `undefined` means "remove the field". */
function coerce(raw: string, kind: EditKind): unknown {
  const text = raw.trim();
  if (text === '') return undefined;
  switch (kind) {
    case 'string':
    case 'url':
      return raw;
    case 'array': {
      if (text.startsWith('[')) return scalar(text);
      return text.split(',').map((s) => scalar(s.trim()));
    }
    case 'bool': {
      const lower = text.toLowerCase();
      if (['true', 'yes', 'on', '1', '✓', 'x'].includes(lower)) return true;
      if (['false', 'no', 'off', '0', '—', '-'].includes(lower)) return false;
      return scalar(text);
    }
    case 'object':
      return scalar(text);
    default:
      return scalar(text);
  }
}

/** Reads `text` as a YAML scalar/flow value, falling back to the plain string. */
function scalar(text: string): unknown {
  try {
    const value = YAML.parse(text);
    return value === undefined ? text : value;
  } catch {
    return text;
  }
}

/** Creates `folder/<name>.md` for a new option unless one already exists. */
export async function createOption(root: vscode.Uri, rel: Relation, name: string): Promise<void> {
  const value = name.trim();
  const safe = value.replace(/[\\/:*?"<>|]/g, '-');
  if (!safe) throw new Error('Option name cannot be empty');
  const uri = vscode.Uri.joinPath(root, `${rel.folder ? `${rel.folder}/` : ''}${safe}.md`);
  try {
    await vscode.workspace.fs.stat(uri);
    return;
  } catch {
    // create below
  }
  const body = rel.field ? `---\n${rel.field}: ${yamlScalar(value)}\n---\n` : `# ${value}\n`;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(body, 'utf8'));
}

function yamlScalar(s: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_ -]*$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s) ? s : JSON.stringify(s);
}
