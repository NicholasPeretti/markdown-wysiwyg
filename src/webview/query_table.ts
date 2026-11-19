/**
 * Query tables: renders ```query code blocks as live tables of workspace
 * files, with CodeMirror highlighting and completions for the query text.
 *
 * Crepe's code block shows a "preview" for a language when
 * `renderPreview` returns content for it. The preview DOM is copied in via
 * innerHTML (sanitised), so interaction is handled by delegation on the
 * editor root and state is kept here, keyed by a per-block id.
 */

import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import type { CompletionContext as CmCompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import { addBlockTypeCommand, clearTextInCurrentBlockCommand, codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import type { SlashMenuBuilder } from './callouts';
import type { Ctx } from '@milkdown/kit/ctx';
import type { EditorView } from '@milkdown/kit/prose/view';
import { complete, type CompletionContext } from '../query/complete';
import {
  FILE_FIELDS,
  OPERATORS,
  QUERY_KEYS,
  newFileFolder,
  parseQuery,
  usesSelf,
  validateName,
  withSort,
  type SortDir,
} from '../query/lang';
import type { Relation } from '../query/relations';
import { openRelationPicker, type PickerOption } from './relation_picker';
import { fetchOptions } from './relation_options';
import { isolateInput } from './keys';

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

interface Result {
  columns: string[];
  rows: { path: string; cells: Cell[] }[];
  total: number;
  groups?: { value: Cell; rows: number[] }[];
}

interface BlockState {
  text: string;
  result?: Result;
  error?: string;
  page: number;
  /** Free-text filter typed in the footer; never written to the file. */
  search: string;
  /** Group labels the user has folded. */
  collapsed: Set<string>;
  /** Path of a row to highlight on the next render (a file just created). */
  focusPath?: string;
  apply: (el: HTMLElement) => void;
}

interface Host {
  post(message: unknown): void;
  ctx(): Ctx | undefined;
  /** Raw frontmatter of the current document, for `$.field` references. */
  frontmatter(): string | null;
}

const blocks = new Map<string, BlockState>();
const pending = new Map<string, string>(); // request id → block id
let seq = 0;
let host: Host | undefined;

/** Resolves pending completion-context requests. */
let contextPromise: Promise<CompletionContext> | undefined;
let contextResolve: ((c: CompletionContext) => void) | undefined;
let contextFetchedAt = 0;

export function installQueryTables(h: Host): void {
  host = h;
  document.addEventListener('click', onClick, true);
  document.addEventListener('dblclick', onDoubleClick, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('input', onFilterInput, true);
  document.addEventListener('keydown', onFilterKeydown, true);
}

/** `renderPreview` for Crepe's code block config. */
export function renderQueryPreview(
  language: string,
  content: string,
  apply: (el: HTMLElement | string | null) => void
): undefined | null {
  if (language.toLowerCase() !== 'query') return null;
  // Identify the block by its text; identical blocks share state, which is fine.
  const id = blockId(content);
  const state: BlockState = blocks.get(id) ?? { text: content, page: 0, search: '', collapsed: new Set(), apply };
  state.apply = apply;
  state.text = content;
  blocks.set(id, state);

  if (state.result || state.error) {
    apply(render(id, state));
  } else {
    apply(renderShell(id, '<div class="mdw-qt-status">Querying…</div>', false));
  }
  run(id);
  return undefined;
}

/** Re-runs every rendered query; called when the host index changes. */
export function refreshQueryTables(): void {
  for (const id of blocks.keys()) run(id);
}

/** Re-runs the queries that read the current file's frontmatter via `$.field`. */
export function refreshSelfQueries(): void {
  for (const [id, state] of blocks) {
    const { query } = parseQuery(state.text);
    if (query.where.some(usesSelf)) run(id);
  }
}

export function handleQueryMessage(message: { type: string; id?: string } & { [k: string]: unknown }): boolean {
  switch (message.type) {
    case 'queryResult': {
      const blockIdFor = pending.get(message.id as string);
      pending.delete(message.id as string);
      if (!blockIdFor) return true;
      const state = blocks.get(blockIdFor);
      if (!state) return true;
      state.result = normalizeColumns({
        columns: message.columns as string[],
        rows: message.rows as Result['rows'],
        total: message.total as number,
        groups: message.groups as Result['groups'],
      });
      state.error = undefined;
      // Keep the current page so an edit-triggered refresh does not jump around.
      if (editingBlock === blockIdFor) {
        deferredRender.add(blockIdFor);
      } else {
        state.apply(render(blockIdFor, state));
        if (state.focusPath) revealFocusedRow(blockIdFor, state);
      }
      return true;
    }
    case 'queryError': {
      const blockIdFor = pending.get(message.id as string);
      pending.delete(message.id as string);
      if (!blockIdFor) return true;
      const state = blocks.get(blockIdFor);
      if (!state) return true;
      state.error = String(message.message);
      state.result = undefined;
      state.apply(render(blockIdFor, state));
      return true;
    }
    case 'queryContextResult': {
      contextResolve?.({
        fields: message.fields as string[],
        values: message.values as CompletionContext['values'],
        folders: message.folders as string[],
      });
      contextResolve = undefined;
      return true;
    }
    case 'queryRefresh':
      refreshQueryTables();
      return true;
    case 'newFileContextResult': {
      const resolve = newFileWaiters.get(message.id as string);
      newFileWaiters.delete(message.id as string);
      resolve?.(message.folder === null ? undefined : { folder: String(message.folder), names: message.names as string[] });
      return true;
    }
    case 'fileCreated': {
      const blockIdFor = pending.get(message.id as string);
      pending.delete(message.id as string);
      const state = blockIdFor ? blocks.get(blockIdFor) : undefined;
      if (!state || !blockIdFor) return true;
      if (typeof message.error === 'string') {
        showNewFileError(blockIdFor, message.error);
      } else {
        state.focusPath = String(message.path);
        run(blockIdFor);
      }
      return true;
    }
  }
  return false;
}

/** Scrolls to the row just created and clears the highlight once it has been seen. */
function revealFocusedRow(id: string, state: BlockState): void {
  const path = state.focusPath;
  if (!path) return;
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`.mdw-qt[data-qid="${id}"] tr.mdw-qt-focus`);
    if (!row) {
      // Not in the results (yet): keep waiting for the index to catch up, but not forever.
      focusAttempts.set(id, (focusAttempts.get(id) ?? 0) + 1);
      if ((focusAttempts.get(id) ?? 0) > 3) {
        focusAttempts.delete(id);
        state.focusPath = undefined;
      }
      return;
    }
    focusAttempts.delete(id);
    row.scrollIntoView({ block: 'nearest' });
    setTimeout(() => {
      if (state.focusPath === path) {
        state.focusPath = undefined;
        row.classList.remove('mdw-qt-focus');
      }
    }, 2500);
  });
}

const focusAttempts = new Map<string, number>();

interface NewFileContext {
  folder: string;
  names: string[];
}

const newFileWaiters = new Map<string, (c: NewFileContext | undefined) => void>();

function fetchNewFileContext(text: string): Promise<NewFileContext | undefined> {
  return new Promise((resolve) => {
    if (!host) return resolve(undefined);
    const id = `n${++seq}`;
    newFileWaiters.set(id, resolve);
    host.post({ type: 'newFileContext', id, text });
  });
}

function run(id: string): void {
  const state = blocks.get(id);
  if (!state || !host) return;
  // Validate locally first for instant feedback.
  const { errors } = parseQuery(state.text);
  if (errors.length) {
    state.error = errors.map((e) => `Line ${e.line + 1}: ${e.message}`).join('\n');
    state.result = undefined;
    state.apply(render(id, state));
    return;
  }
  const reqId = `q${++seq}`;
  pending.set(reqId, id);
  host.post({ type: 'query', id: reqId, text: state.text, frontmatter: host.frontmatter() });
}

function blockId(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `b${(h >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Rendering

const EDIT_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>';

const menuHtml = (filter: string) => `${filter}<span class="mdw-qt-actions">
  <button data-act="edit" class="mdw-qt-edit" title="Edit query" aria-pressed="false">${EDIT_ICON}</button>
  <span class="mdw-qt-menu">
    <button data-act="menu" class="mdw-qt-menu-btn" title="More actions" aria-haspopup="menu">⋯</button>
    <span class="mdw-qt-menu-list" role="menu">
      <button data-act="copy" role="menuitem">Copy as Markdown</button>
      <button data-act="copy-query" role="menuitem">Copy query</button>
    </span>
  </span>
</span>`;

function renderShell(id: string, inner: string, withMenu = true, filter = ''): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mdw-qt';
  el.dataset.qid = id;
  el.innerHTML = inner;
  if (withMenu) {
    el.insertAdjacentHTML('afterbegin', `<div class="mdw-qt-toolbar">${menuHtml(filter)}</div>`);
  }
  return el;
}

function render(id: string, state: BlockState): HTMLElement {
  if (state.error) {
    return renderShell(id, `<div class="mdw-qt-error">${escapeHtml(state.error).replace(/\n/g, '<br>')}</div>`);
  }
  const result = state.result!;
  const { query } = parseQuery(state.text);
  const grouped = !!result.groups;
  const visible = filterRows(result, state.search);
  const pageSize = grouped ? visible.rows.length : (query.page ?? visible.rows.length);
  const pageCount = Math.max(1, Math.ceil(visible.rows.length / pageSize));
  const page = Math.min(state.page, pageCount - 1);
  const start = page * pageSize;
  const rows = visible.rows.slice(start, start + pageSize);
  const sort = query.sort[0];

  const noun = query.distinct ? 'value' : 'file';
  const plural = (n: number) => `${noun}${n === 1 ? '' : 's'}`;
  const count = state.search.trim()
    ? `${visible.rows.length} of ${result.total} ${plural(result.total)}`
    : result.total > result.rows.length
      ? `${result.rows.length} of ${result.total} ${noun}s`
      : `${result.total} ${plural(result.total)}`;
  const pager =
    pageCount > 1
      ? `<span class="mdw-qt-pager">
          <button data-act="prev" ${page === 0 ? 'disabled' : ''} title="Previous page">‹</button>
          <span>${start + 1}–${Math.min(start + pageSize, visible.rows.length)}</span>
          <button data-act="next" ${page >= pageCount - 1 ? 'disabled' : ''} title="Next page">›</button>
        </span>`
      : '';
  const filter = `<label class="mdw-qt-filter">
      ${FILTER_ICON}
      <input type="text" placeholder="Filter rows…" spellcheck="false" value="${escapeAttr(state.search)}" aria-label="Filter rows">
      <button data-act="clear-filter" title="Clear filter">×</button>
    </label>`;

  const head = result.columns
    .map((c) => {
      const active = sort?.field === c;
      const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th data-act="sort" data-field="${escapeAttr(c)}" class="${active ? 'mdw-qt-sorted' : ''}" title="Sort by ${escapeAttr(c)}">${escapeHtml(c)}${arrow}</th>`;
    })
    .join('');

  const renderRow = (row: Result['rows'][number]) =>
    `<tr${row.path ? ` data-path="${escapeAttr(row.path)}"` : ''}${
      row.path && row.path === state.focusPath ? ' class="mdw-qt-focus"' : ''
    }>${row.cells
      .map((cell, i) => {
        const mode = row.path ? editMode(result.columns[i], cell) : null;
        const hint = mode === 'field' || mode === 'rename' ? ' title="Double-click to edit"' : '';
        const attrs = mode ? ` data-col="${i}" data-edit="${mode}"${hint}` : '';
        return `<td${attrs}>${mode ? renderEditableCell(cell, mode) : renderCell(cell)}</td>`;
      })
      .join('')}</tr>`;
  const empty = `<tbody><tr class="mdw-qt-empty"><td colspan="${result.columns.length}">${
    state.search.trim() ? `No rows match “${escapeHtml(state.search.trim())}”` : 'No files match'
  }</td></tr></tbody>`;

  let body: string;
  if (visible.groups) {
    body = visible.groups.length
      ? visible.groups
          .map((g) => {
            const label = g.value.kind === 'null' ? `No ${query.group}` : cellText(g.value);
            const folded = state.collapsed.has(label);
            return `<tbody class="mdw-qt-group${folded ? ' mdw-qt-folded' : ''}">
              <tr class="mdw-qt-group-head" data-act="group" data-group="${escapeAttr(label)}">
                <td colspan="${result.columns.length}">
                  <span class="mdw-qt-chevron" aria-hidden="true"></span>
                  <span class="mdw-qt-group-label">${g.value.kind === 'null' ? `<span class="mdw-qt-null">${escapeHtml(label)}</span>` : renderCell(g.value)}</span>
                  <span class="mdw-qt-group-count">${g.rows.length}</span>
                </td>
              </tr>
              ${folded ? '' : g.rows.map((i) => renderRow(visible.rows[i])).join('')}
            </tbody>`;
          })
          .join('')
      : empty;
  } else {
    body = rows.length ? `<tbody>${rows.map(renderRow).join('')}</tbody>` : empty;
  }
  // Notion-style "+ New" row, only where a created file would land somewhere obvious.
  if (newFileFolder(query) !== undefined && !state.search.trim()) {
    body += `<tbody class="mdw-qt-new"><tr><td colspan="${result.columns.length}">
      <button data-act="new-file" class="mdw-qt-new-btn" title="Create a new file matching this query">${PLUS_ICON}<span>New</span></button>
    </td></tr></tbody>`;
  }

  return renderShell(
    id,
    `<div class="mdw-qt-scroll"><table><thead><tr>${head}</tr></thead>${body}</table></div>
    <div class="mdw-qt-footer">
      <span class="mdw-qt-count">${count}</span>
      ${pager}
    </div>`,
    true,
    filter
  );
}

const PLUS_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/></svg>';

const FILTER_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>';

/**
 * Keeps the rows whose visible cells contain every word of `search`
 * (case-insensitive). Groups are re-pointed at the kept rows and emptied
 * groups dropped, so the folding headers stay accurate.
 */
function filterRows(result: Result, search: string): Pick<Result, 'rows' | 'groups'> {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return result;
  const index = new Map<number, number>();
  const rows: Result['rows'] = [];
  result.rows.forEach((row, i) => {
    const hay = (row.cells.map(cellText).join('\n') + '\n' + row.path).toLowerCase();
    if (terms.every((t) => hay.includes(t))) {
      index.set(i, rows.length);
      rows.push(row);
    }
  });
  const groups = result.groups
    ?.map((g) => ({ value: g.value, rows: g.rows.filter((i) => index.has(i)).map((i) => index.get(i)!) }))
    .filter((g) => g.rows.length);
  return { rows, groups };
}

function renderCell(cell: Cell): string {
  switch (cell.kind) {
    case 'null':
      return '<span class="mdw-qt-null">—</span>';
    case 'string':
      return escapeHtml(cell.value);
    case 'url':
      return `<a href="${escapeAttr(cell.value)}">${escapeHtml(cell.value)}</a>`;
    case 'number':
      return `<span class="mdw-qt-number">${cell.value}</span>`;
    case 'bool':
      return cell.value ? '<span class="mdw-qt-bool">✓</span>' : '<span class="mdw-qt-null">—</span>';
    case 'date': {
      const d = new Date(cell.value);
      return `<time datetime="${cell.value}" title="${d.toLocaleString()}">${relativeTime(d)}</time>`;
    }
    case 'array':
      return cell.value.map((v) => `<span class="mdw-qt-pill">${escapeHtml(v)}</span>`).join('');
    case 'object':
      return `<code>${escapeHtml(cell.value)}</code>`;
    case 'relation':
      if (!cell.items.length) return '<span class="mdw-qt-null">—</span>';
      return cell.items
        .map((it) =>
          it.path
            ? `<span class="mdw-qt-pill mdw-qt-rel" data-rel-path="${escapeAttr(it.path)}" title="⌘-click to open">${escapeHtml(it.label ?? it.value)}</span>`
            : `<span class="mdw-qt-pill mdw-qt-rel mdw-qt-rel-missing" title="No such option">${escapeHtml(it.value)}</span>`
        )
        .join('');
  }
}

/**
 * Gives empty cells the shape of their column (checkbox, pills, relation) when
 * every non-empty cell in it agrees, so a value can be added in place.
 */
function normalizeColumns(result: Result): Result {
  result.columns.forEach((column, i) => {
    if (column.startsWith('file.')) return;
    let shape: Cell | undefined;
    for (const row of result.rows) {
      const c = row.cells[i];
      if (c.kind === 'null') continue;
      if (c.kind !== 'bool' && c.kind !== 'array' && c.kind !== 'relation') return;
      if (shape && shape.kind !== c.kind) return;
      shape = shape ?? c;
    }
    if (!shape) return;
    for (const row of result.rows) {
      if (row.cells[i].kind !== 'null' || !row.path) continue;
      row.cells[i] =
        shape.kind === 'bool'
          ? { kind: 'bool', value: false }
          : shape.kind === 'array'
            ? { kind: 'array', value: [] }
            : { kind: 'relation', items: [], relation: (shape as Extract<Cell, { kind: 'relation' }>).relation };
    }
  });
  return result;
}

/** Cells of editable rows get controls: checkboxes, removable pills, dropdown-like relations. */
function renderEditableCell(cell: Cell, mode: EditMode): string {
  switch (mode) {
    case 'bool': {
      const checked = cell.kind === 'bool' && cell.value;
      return `<label class="mdw-qt-check-host" data-act="toggle"><input type="checkbox" class="mdw-qt-check" ${checked ? 'checked' : ''} aria-label="Toggle"></label>`;
    }
    case 'array': {
      const values = cell.kind === 'array' ? cell.value : [];
      return `<span class="mdw-qt-pills">${values
        .map((v, i) => removablePill(escapeHtml(v), 'arr-remove', i))
        .join('')}${addButton('arr-add')}</span>`;
    }
    case 'relation': {
      if (cell.kind !== 'relation') return renderCell(cell);
      if (!cell.relation.multi) {
        const it = cell.items[0];
        const inner = it
          ? `<span class="mdw-qt-sel-text${it.path ? '' : ' mdw-qt-rel-missing'}"${it.path ? ` data-rel-path="${escapeAttr(it.path)}"` : ''}>${escapeHtml(it.label ?? it.value)}</span>`
          : '<span class="mdw-qt-null">—</span>';
        return `<span class="mdw-qt-select" data-act="rel-pick" title="Click to change">${inner}<span class="mdw-qt-sel-chevron" aria-hidden="true">▾</span></span>`;
      }
      return `<span class="mdw-qt-pills">${cell.items
        .map((it, i) =>
          removablePill(
            escapeHtml(it.label ?? it.value),
            'rel-remove',
            i,
            it.path ? `mdw-qt-rel" data-rel-path="${escapeAttr(it.path)}` : 'mdw-qt-rel mdw-qt-rel-missing'
          )
        )
        .join('')}${addButton('rel-pick')}</span>`;
    }
    default:
      return renderCell(cell);
  }
}

function removablePill(html: string, act: string, index: number, extraClass = ''): string {
  return `<span class="mdw-qt-pill mdw-qt-pill-rm ${extraClass}"><span>${html}</span><button class="mdw-qt-pill-x" data-act="${act}" data-idx="${index}" title="Remove" aria-label="Remove">✕</button></span>`;
}

function addButton(act: string): string {
  return `<button class="mdw-qt-pill-add" data-act="${act}" title="Add" aria-label="Add">+</button>`;
}

function cellText(cell: Cell): string {
  switch (cell.kind) {
    case 'null':
      return '';
    case 'bool':
      return cell.value ? 'true' : 'false';
    case 'date':
      return cell.value.slice(0, 10);
    case 'array':
      return cell.value.join(', ');
    case 'relation':
      return cell.items.map((i) => i.label ?? i.value).join(', ');
    default:
      return String(cell.value);
  }
}

export function relativeTime(date: Date): string {
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < minute) return 'just now';
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  if (abs < 30 * day) return rtf.format(Math.round(diff / day), 'day');
  if (abs < 365 * day) return rtf.format(Math.round(diff / (30 * day)), 'month');
  return rtf.format(Math.round(diff / (365 * day)), 'year');
}

function toMarkdown(result: Result, rows: Result['rows']): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `| ${result.columns.map(esc).join(' | ')} |`,
    `| ${result.columns.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.cells.map((c) => esc(cellText(c))).join(' | ')} |`),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// In-place editing

type EditMode = 'field' | 'rename' | 'relation' | 'bool' | 'array';

/** Whether a cell can be edited: frontmatter scalars/arrays and `file.name`. */
function editMode(column: string, cell: Cell): EditMode | null {
  if (column === 'file.name') return 'rename';
  if (column.startsWith('file.')) return null;
  if (cell.kind === 'relation') return 'relation';
  if (cell.kind === 'bool') return 'bool';
  if (cell.kind === 'array') return 'array';
  return cell.kind === 'object' ? null : 'field';
}

interface CellContext {
  root: HTMLElement;
  state: BlockState;
  td: HTMLElement;
  record: Result['rows'][number];
  col: number;
  cell: Cell;
}

function cellContext(target: HTMLElement): CellContext | undefined {
  const td = target.closest<HTMLElement>('.mdw-qt td[data-edit]');
  if (!td) return undefined;
  const root = td.closest<HTMLElement>('.mdw-qt')!;
  const state = blocks.get(root.dataset.qid!);
  const row = td.closest<HTMLElement>('tr[data-path]');
  if (!state?.result || !row) return undefined;
  const col = Number(td.dataset.col);
  const record = state.result.rows.find((r) => r.path === row.dataset.path);
  const cell = record?.cells[col];
  return record && cell ? { root, state, td, record, col, cell } : undefined;
}

function openRelationEditor(
  td: HTMLElement,
  root: HTMLElement,
  state: BlockState,
  record: Result['rows'][number],
  col: number,
  options: PickerOption[]
): void {
  const cell = record.cells[col];
  if (cell.kind !== 'relation') return;
  const rel = cell.relation;
  const field = state.result!.columns[col];
  const id = root.dataset.qid!;
  editingBlock = id;
  td.classList.add('mdw-qt-editing-cell');
  openRelationPicker({
    anchor: td,
    options,
    selected: cell.items.map((i) => i.value),
    multi: rel.multi,
    onClose: (values, created, changed) => {
      editingBlock = undefined;
      td.classList.remove('mdw-qt-editing-cell');
      if (changed) {
        record.cells[col] = {
          kind: 'relation',
          relation: rel,
          items: values.map((v) => {
            const o = options.find((o) => o.value === v);
            return { value: v, path: o?.path || undefined, label: o && o.label !== v ? o.label : undefined };
          }),
        };
        host?.post({ type: 'setRelation', path: record.path, field, values, relation: rel, create: created });
      }
      replaceContent(root, render(id, state));
      if (deferredRender.delete(id)) state.apply(render(id, state));
    },
  });
}

/** Block id whose table currently hosts an input; results are held back meanwhile. */
let editingBlock: string | undefined;
const deferredRender = new Set<string>();

function onDoubleClick(e: MouseEvent): void {
  const ctx = cellContext(e.target as HTMLElement);
  if (!ctx || ctx.td.querySelector('input:not([type=checkbox])')) return;
  const mode = ctx.td.dataset.edit as EditMode;
  // Booleans, lists and relations have their own single-click controls.
  if (mode !== 'field' && mode !== 'rename') return;
  e.preventDefault();
  e.stopPropagation();
  beginEdit(ctx.td, ctx.root, ctx.state, ctx.record, ctx.col);
}

/** Single-click controls inside editable cells. Returns false when `act` is not a cell action. */
function cellAction(act: string, target: HTMLElement): boolean {
  const ctx = cellContext(target);
  if (!ctx) return false;
  const { root, state, td, record, col, cell } = ctx;
  const idx = Number(target.closest<HTMLElement>('[data-idx]')?.dataset.idx ?? -1);
  switch (act) {
    case 'toggle':
      commitEdit(root, state, record, col, cell.kind === 'bool' && cell.value ? 'false' : 'true');
      return true;
    case 'arr-remove': {
      if (cell.kind !== 'array') return true;
      const rest = cell.value.filter((_, i) => i !== idx);
      commitEdit(root, state, record, col, rest.length ? rest.join(', ') : '[]');
      return true;
    }
    case 'arr-add':
      beginArrayAdd(ctx);
      return true;
    case 'rel-remove': {
      if (cell.kind !== 'relation') return true;
      const values = cell.items.filter((_, i) => i !== idx).map((i) => i.value);
      record.cells[col] = { ...cell, items: cell.items.filter((_, i) => i !== idx) };
      host?.post({
        type: 'setRelation',
        path: record.path,
        field: state.result!.columns[col],
        values,
        relation: cell.relation,
        create: [],
      });
      replaceContent(root, render(root.dataset.qid!, state));
      return true;
    }
    case 'rel-pick': {
      if (cell.kind !== 'relation' || editingBlock) return true;
      void fetchOptions(cell.relation).then((options) => {
        if (td.isConnected) openRelationEditor(td, root, state, record, col, options);
      });
      return true;
    }
  }
  return false;
}

/** Appends an input to a list cell; Enter adds one value. */
function beginArrayAdd({ root, state, td, record, col, cell }: CellContext): void {
  const values = cell.kind === 'array' ? cell.value : [];
  const pills = td.querySelector<HTMLElement>('.mdw-qt-pills');
  if (!pills || pills.querySelector('input')) return;
  const id = root.dataset.qid!;
  editingBlock = id;
  td.classList.add('mdw-qt-editing-cell');
  pills.querySelector('.mdw-qt-pill-add')?.remove();
  const input = document.createElement('input');
  input.className = 'mdw-qt-pill-input';
  input.placeholder = 'Add…';
  input.spellcheck = false;
  pills.appendChild(input);

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    editingBlock = undefined;
    const value = input.value.trim();
    if (commit && value) commitEdit(root, state, record, col, [...values, value].join(', '));
    else replaceContent(root, render(id, state));
    if (deferredRender.delete(id)) state.apply(render(id, state));
  };
  isolateInput(input);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.focus();
}

function beginEdit(
  td: HTMLElement,
  root: HTMLElement,
  state: BlockState,
  record: Result['rows'][number],
  col: number
): void {
  const cell = record.cells[col];
  const initial = cellText(cell);
  editingBlock = root.dataset.qid;
  td.classList.add('mdw-qt-editing-cell');
  td.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'mdw-qt-input';
  input.type = 'text';
  input.value = initial;
  input.spellcheck = false;
  input.placeholder = cell.kind === 'array' ? 'a, b, c' : cell.kind === 'date' ? 'YYYY-MM-DD' : '';
  td.appendChild(input);

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    editingBlock = undefined;
    const value = input.value;
    if (commit && value !== initial) {
      commitEdit(root, state, record, col, value);
    } else {
      replaceContent(root, render(root.dataset.qid!, state));
    }
    if (deferredRender.delete(root.dataset.qid!)) {
      state.apply(render(root.dataset.qid!, state));
    }
  };

  // Keep ProseMirror/CodeMirror from seeing keystrokes meant for the input.
  isolateInput(input);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.focus();
  input.select();
}

/**
 * Turns the "+ New" row into a name input. Like the explorer, the name is
 * validated as you type and the file is only created on Enter.
 */
function beginNewFile(root: HTMLElement, state: BlockState): void {
  const id = root.dataset.qid!;
  const td = root.querySelector<HTMLElement>('.mdw-qt-new td');
  if (!td || !state.result) return;
  editingBlock = id;
  td.innerHTML = '';
  td.classList.add('mdw-qt-new-editing');
  const wrap = document.createElement('div');
  wrap.className = 'mdw-qt-new-form';
  const input = document.createElement('input');
  input.className = 'mdw-qt-input';
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = 'File name';
  input.setAttribute('aria-label', 'New file name');
  const error = document.createElement('div');
  error.className = 'mdw-qt-new-error';
  error.hidden = true;
  wrap.append(input, error);
  td.appendChild(wrap);

  let context: NewFileContext | undefined;
  let names: string[] = [];
  let loaded = false;
  void fetchNewFileContext(state.text).then((c) => {
    loaded = true;
    context = c;
    names = c?.names ?? [];
    if (!c) {
      input.disabled = true;
      setError('This query cannot create files.');
    } else {
      input.placeholder = c.folder ? `File name (in ${c.folder}/)` : 'File name';
      validate();
    }
  });

  const setError = (msg: string | undefined) => {
    error.textContent = msg ?? '';
    error.hidden = !msg;
    wrap.classList.toggle('mdw-qt-invalid', !!msg);
  };
  // Blank is only an error once the user has typed something.
  let touched = false;
  const validate = (): string | undefined => {
    const problem = validateName(input.value, names);
    setError(touched || input.value ? problem : undefined);
    return problem;
  };

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    editingBlock = undefined;
    const value = input.value.trim();
    if (commit && loaded && context && value && !validateName(value, names)) {
      const reqId = `f${++seq}`;
      pending.set(reqId, id);
      host?.post({ type: 'createFile', id: reqId, text: state.text, name: value, frontmatter: host.frontmatter() });
      td.classList.remove('mdw-qt-new-editing');
      td.innerHTML = `<span class="mdw-qt-status">Creating ${escapeHtml(value)}.md…</span>`;
    } else {
      replaceContent(root, render(id, state));
    }
    if (deferredRender.delete(id)) state.apply(render(id, state));
  };

  isolateInput(input);
  input.addEventListener('input', () => {
    touched = true;
    validate();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      touched = true;
      if (!validate()) finish(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finish(false);
    }
  });
  // Clicking away commits a valid name and drops an invalid one, like the explorer.
  input.addEventListener('blur', () => (validateName(input.value, names) ? finish(false) : finish(true)));
  input.focus();
}

/** Shows a creation failure in the "+ New" row until the next render. */
function showNewFileError(id: string, message: string): void {
  const state = blocks.get(id);
  const root = document.querySelector<HTMLElement>(`.mdw-qt[data-qid="${id}"]`);
  if (!state || !root) return;
  replaceContent(root, render(id, state));
  const td = root.querySelector<HTMLElement>('.mdw-qt-new td');
  if (td) td.insertAdjacentHTML('beforeend', `<div class="mdw-qt-new-error">${escapeHtml(message)}</div>`);
}

/** Applies `value` optimistically and asks the host to persist it. */
function commitEdit(
  root: HTMLElement,
  state: BlockState,
  record: Result['rows'][number],
  col: number,
  value: string
): void {
  const id = root.dataset.qid!;
  const column = state.result!.columns[col];
  const previous = record.cells[col];
  if (column === 'file.name') {
    const name = value.trim();
    if (!name) {
      replaceContent(root, render(id, state));
      return;
    }
    record.cells[col] = { kind: 'string', value: name };
    host?.post({ type: 'renameFile', path: record.path, value: name });
  } else {
    record.cells[col] = optimisticCell(value, previous);
    host?.post({ type: 'setField', path: record.path, field: column, value, kind: previous.kind });
  }
  replaceContent(root, render(id, state));
}

function optimisticCell(value: string, previous: Cell): Cell {
  const text = value.trim();
  if (!text) return { kind: 'null' };
  switch (previous.kind) {
    case 'bool':
      return { kind: 'bool', value: /^(true|yes|on|1|✓|x)$/i.test(text) };
    case 'number':
      return Number.isFinite(Number(text)) ? { kind: 'number', value: Number(text) } : { kind: 'string', value: text };
    case 'array':
      return { kind: 'array', value: text.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean) };
    case 'date': {
      const d = new Date(text);
      return Number.isNaN(d.getTime()) ? { kind: 'string', value: text } : { kind: 'date', value: d.toISOString() };
    }
    case 'url':
    case 'string':
      return /^https?:\/\/\S+$/i.test(text) ? { kind: 'url', value: text } : { kind: 'string', value };
    default: {
      if (/^-?\d+(\.\d+)?$/.test(text)) return { kind: 'number', value: Number(text) };
      if (/^(true|false)$/i.test(text)) return { kind: 'bool', value: text.toLowerCase() === 'true' };
      return { kind: 'string', value: text };
    }
  }
}


function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const root = target.closest<HTMLElement>('.mdw-qt');
  if (!root) {
    closeMenus();
    return;
  }
  const id = root.dataset.qid!;
  const state = blocks.get(id);
  if (!state) return;

  // cmd/ctrl+click a relation pill opens its target, even inside a control.
  const pill = target.closest<HTMLElement>('[data-rel-path]');
  if (pill && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    e.stopPropagation();
    host?.post({ type: 'openFile', path: pill.dataset.relPath });
    return;
  }

  const action = target.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (action) {
    e.preventDefault();
    e.stopPropagation();
    if (action !== 'menu') closeMenus();
    if (cellAction(action, target)) return;
    switch (action) {
      case 'menu': {
        const menu = target.closest<HTMLElement>('.mdw-qt-menu')!;
        const open = menu.classList.contains('open');
        closeMenus();
        if (!open) menu.classList.add('open');
        break;
      }
      case 'edit': {
        const block = root.closest<HTMLElement>('.milkdown-code-block');
        const editing = !!block?.querySelector('.codemirror-host.hidden');
        block?.querySelector<HTMLElement>('.preview-toggle-button')?.click();
        syncEditToggle(block, editing);
        // On a long table the editor replaces rows that were above the fold.
        if (editing && block && block.getBoundingClientRect().top < 0) {
          block.scrollIntoView({ block: 'start' });
        }
        break;
      }
      case 'copy-query':
        void navigator.clipboard.writeText(state.text);
        break;
      case 'new-file':
        beginNewFile(root, state);
        break;
      case 'group': {
        const label = target.closest<HTMLElement>('[data-group]')!.dataset.group!;
        if (!state.collapsed.delete(label)) state.collapsed.add(label);
        replaceContent(root, render(id, state));
        break;
      }
      case 'prev':
        state.page = Math.max(0, state.page - 1);
        replaceContent(root, render(id, state));
        break;
      case 'next':
        state.page += 1;
        replaceContent(root, render(id, state));
        break;
      case 'clear-filter':
        state.search = '';
        state.page = 0;
        replaceContent(root, render(id, state));
        root.querySelector<HTMLInputElement>('.mdw-qt-filter input')?.focus();
        break;
      case 'copy': {
        if (!state.result) break;
        const { query } = parseQuery(state.text);
        const visible = filterRows(state.result, state.search);
        const pageSize = query.page ?? visible.rows.length;
        const page = Math.min(state.page, Math.max(0, Math.ceil(visible.rows.length / pageSize) - 1));
        const rows = visible.rows.slice(page * pageSize, (page + 1) * pageSize);
        void navigator.clipboard.writeText(toMarkdown(state.result, rows));
        break;
      }
      case 'sort': {
        const field = target.closest<HTMLElement>('[data-field]')!.dataset.field!;
        const { query } = parseQuery(state.text);
        const current = query.sort[0];
        const dir: SortDir = current?.field === field && current.dir === 'asc' ? 'desc' : 'asc';
        rewriteBlock(root, state.text, withSort(state.text, field, dir));
        break;
      }
    }
    return;
  }

  // cmd/ctrl+click a row opens the file. Links inside cells go through the
  // regular link handler.
  if (target.closest('a[href]')) return;
  const row = target.closest<HTMLElement>('tr[data-path]');
  if (row && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    e.stopPropagation();
    host?.post({ type: 'openFile', path: row.dataset.path });
  }
}

function onMouseMove(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const row = target.closest?.('tr[data-path]');
  document.body.classList.toggle('mdw-qt-mod-row', !!row && (e.metaKey || e.ctrlKey));
}

// ---------------------------------------------------------------------------
// Footer filter

function filterInput(target: EventTarget | null): { input: HTMLInputElement; root: HTMLElement; id: string } | null {
  const input = target as HTMLInputElement | null;
  if (!input?.matches?.('.mdw-qt-filter input')) return null;
  const root = input.closest<HTMLElement>('.mdw-qt');
  return root ? { input, root, id: root.dataset.qid! } : null;
}

/** The filter box is re-created on every render, so wire it lazily on focus. */
function onFocusIn(e: FocusEvent): void {
  const hit = filterInput(e.target);
  if (!hit || hit.input.dataset.wired) return;
  hit.input.dataset.wired = '1';
  isolateInput(hit.input);
}

function onFilterInput(e: Event): void {
  const hit = filterInput(e.target);
  if (!hit) return;
  const state = blocks.get(hit.id);
  if (!state) return;
  state.search = hit.input.value;
  state.page = 0;
  replaceContent(hit.root, render(hit.id, state));
}

function onFilterKeydown(e: KeyboardEvent): void {
  const hit = filterInput(e.target);
  if (!hit || e.key !== 'Escape') return;
  const state = blocks.get(hit.id);
  if (!state) return;
  e.preventDefault();
  e.stopPropagation();
  if (state.search) {
    state.search = '';
    state.page = 0;
    replaceContent(hit.root, render(hit.id, state));
    hit.root.querySelector<HTMLInputElement>('.mdw-qt-filter input')?.focus();
  } else {
    hit.input.blur();
  }
}

/** Reflects edit/result mode on the toggle (the block is re-rendered by Vue, so query the DOM). */
function syncEditToggle(block: HTMLElement | null, editing: boolean): void {
  block?.classList.toggle('mdw-qt-editing', editing);
  block?.querySelectorAll<HTMLElement>('.mdw-qt-edit').forEach((b) => {
    b.setAttribute('aria-pressed', String(editing));
    b.title = editing ? 'Show result' : 'Edit query';
  });
}

function closeMenus(): void {
  document.querySelectorAll('.mdw-qt-menu.open').forEach((m) => m.classList.remove('open'));
}

function replaceContent(root: HTMLElement, fresh: HTMLElement): void {
  // Keep the caret in the filter box across the re-render it triggers.
  const active = document.activeElement as HTMLInputElement | null;
  const typing = !!active && active.matches('.mdw-qt-filter input') && root.contains(active);
  const sel = typing ? [active.selectionStart ?? 0, active.selectionEnd ?? 0] : null;
  root.innerHTML = fresh.innerHTML;
  const box = root.querySelector<HTMLElement>('.mdw-qt-filter');
  if (typing && box) {
    const input = box.querySelector<HTMLInputElement>('input')!;
    input.focus({ preventScroll: true });
    input.setSelectionRange(sel![0], sel![1]);
  }
}

/** Replaces the text of the code block that owns `root` in the ProseMirror doc. */
function rewriteBlock(root: HTMLElement, oldText: string, newText: string): void {
  if (oldText === newText) return;
  const ctx = host?.ctx();
  if (!ctx) return;
  let view: EditorView;
  try {
    view = ctx.get(editorViewCtx);
  } catch {
    return;
  }
  const pos = view.posAtDOM(root, 0);
  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === 'code_block') {
      const start = $pos.before(depth);
      const tr = view.state.tr.replaceWith(
        start + 1,
        start + 1 + node.content.size,
        newText ? view.state.schema.text(newText) : []
      );
      view.dispatch(tr);
      return;
    }
  }
  // posAtDOM may land right before the node view rather than inside it.
  const after = $pos.nodeAfter;
  if (after?.type.name === 'code_block') {
    const tr = view.state.tr.replaceWith(
      pos + 1,
      pos + 1 + after.content.size,
      newText ? view.state.schema.text(newText) : []
    );
    view.dispatch(tr);
  }
}

// ---------------------------------------------------------------------------
// CodeMirror language + completions

const KEYWORDS = new Set(['and', 'or', 'not', 'exists', 'true', 'false', 'null', 'today', 'now', 'asc', 'desc']);

const queryStream = StreamLanguage.define<{ key: string | null }>({
  name: 'query',
  startState: () => ({ key: null }),
  token(stream, state) {
    if (stream.sol()) {
      state.key = null;
      if (stream.match(/^\s*#.*/)) return 'comment';
      const m = stream.match(/^\s*([A-Za-z]+)(?=\s*:)/) as RegExpMatchArray | null;
      if (m) {
        state.key = m[1].toLowerCase();
        return (QUERY_KEYS as readonly string[]).includes(state.key) ? 'propertyName' : 'invalid';
      }
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^:/)) return 'punctuation';
    if (state.key === 'from') {
      stream.skipToEnd();
      return 'string';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^\/(?:[^/\\]|\\.)*\/[a-z]*/)) return 'regexp';
    if (stream.match(/^(==|!=|<=|>=|<|>)/)) return 'operator';
    if (stream.match(/^\$\.[A-Za-z_][\w.-]*/)) return 'variableName.special';
    if (stream.match(/^\d{4}-\d{2}-\d{2}/)) return 'number';
    if (stream.match(/^\d+(\.\d+)?[dwmy]?\b/)) return 'number';
    const word = stream.match(/^[A-Za-z_][\w.-]*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0];
      const lower = w.toLowerCase();
      if (KEYWORDS.has(lower)) return 'keyword';
      if (lower === 'includes' || OPERATORS.some((o) => o.toLowerCase() === lower)) return 'operator';
      if ((FILE_FIELDS as readonly string[]).includes(w)) return 'variableName.special';
      return 'variableName';
    }
    stream.next();
    return null;
  },
  languageData: {
    autocomplete: queryCompletionSource,
    commentTokens: { line: '#' },
  },
});

async function queryCompletionSource(cm: CmCompletionContext): Promise<CompletionResult | null> {
  const line = cm.state.doc.lineAt(cm.pos);
  const column = cm.pos - line.from;
  const ctx = await completionContext();
  const result = complete(line.text, column, ctx);
  if (!result) return null;
  const from = line.from + result.from;
  if (from === cm.pos && !cm.explicit) {
    // Only pop up unprompted when there is a word to complete, except after
    // "key:" and operators where offering the next token is useful.
    const before = line.text.slice(0, column);
    if (!/[:\s]$/.test(before)) return null;
  }
  const typeOf: { [k: string]: string } = {
    key: 'property',
    field: 'variable',
    operator: 'keyword',
    value: 'text',
    folder: 'namespace',
    keyword: 'keyword',
  };
  return {
    from,
    options: result.items.map((item, i) => ({
      label: item.label,
      apply: item.insert ?? item.label,
      type: typeOf[item.kind],
      detail: item.detail,
      boost: -i,
    })),
    validFor: /^[\w.\-/"']*$/,
  };
}

function completionContext(): Promise<CompletionContext> {
  const fresh = Date.now() - contextFetchedAt < 5000;
  if (contextPromise && fresh) return contextPromise;
  if (!host) return Promise.resolve({ fields: [], values: {}, folders: [] });
  contextFetchedAt = Date.now();
  contextPromise = new Promise<CompletionContext>((resolve) => {
    contextResolve = resolve;
    // Don't hang the completion UI if the host never answers.
    setTimeout(() => resolve({ fields: [], values: {}, folders: [] }), 3000);
  });
  host.post({ type: 'queryContext', id: `c${++seq}` });
  return contextPromise;
}

export const queryLanguage = LanguageDescription.of({
  name: 'query',
  alias: ['query'],
  extensions: [],
  support: new LanguageSupport(queryStream),
});

// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

const QUERY_SKELETON = 'from: .\nwhere: file.modified > now - 7d\nsort: file.modified desc\nlimit: 10';

/** Adds a "Query table" item (`/query`) to Crepe's Advanced slash group. */
export function addQuerySlashItem(builder: SlashMenuBuilder): void {
  const group = builder.getGroup('advanced');
  group.addItem('query', {
    label: 'Query table',
    icon: '<span class="mdw-qt-slash-icon">⌕</span>',
    onRun: (ctx: Ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(addBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx), attrs: { language: 'query' } });
      const view = ctx.get(editorViewCtx);
      const { $from } = view.state.selection;
      if ($from.parent.type.name === 'code_block') {
        view.dispatch(view.state.tr.insertText(QUERY_SKELETON, $from.pos));
      }
    },
  });
}
