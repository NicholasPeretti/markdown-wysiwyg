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
import { FILE_FIELDS, OPERATORS, QUERY_KEYS, parseQuery, withSort, type SortDir } from '../query/lang';

export type Cell =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'url'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'date'; value: string }
  | { kind: 'array'; value: string[] }
  | { kind: 'object'; value: string };

interface Result {
  columns: string[];
  rows: { path: string; cells: Cell[] }[];
  total: number;
}

interface BlockState {
  text: string;
  result?: Result;
  error?: string;
  page: number;
  apply: (el: HTMLElement) => void;
}

interface Host {
  post(message: unknown): void;
  ctx(): Ctx | undefined;
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
  document.addEventListener('mousemove', onMouseMove, true);
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
  const state: BlockState = blocks.get(id) ?? { text: content, page: 0, apply };
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

export function handleQueryMessage(message: { type: string; id?: string } & { [k: string]: unknown }): boolean {
  switch (message.type) {
    case 'queryResult': {
      const blockIdFor = pending.get(message.id as string);
      pending.delete(message.id as string);
      if (!blockIdFor) return true;
      const state = blocks.get(blockIdFor);
      if (!state) return true;
      state.result = {
        columns: message.columns as string[],
        rows: message.rows as Result['rows'],
        total: message.total as number,
      };
      state.error = undefined;
      state.page = 0;
      state.apply(render(blockIdFor, state));
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
  }
  return false;
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
  host.post({ type: 'query', id: reqId, text: state.text });
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

const MENU_HTML = `<span class="mdw-qt-actions">
  <button data-act="edit" class="mdw-qt-edit" title="Edit query" aria-pressed="false">${EDIT_ICON}</button>
  <span class="mdw-qt-menu">
    <button data-act="menu" class="mdw-qt-menu-btn" title="More actions" aria-haspopup="menu">⋯</button>
    <span class="mdw-qt-menu-list" role="menu">
      <button data-act="copy" role="menuitem">Copy as Markdown</button>
      <button data-act="copy-query" role="menuitem">Copy query</button>
    </span>
  </span>
</span>`;

function renderShell(id: string, inner: string, withMenu = true): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mdw-qt';
  el.dataset.qid = id;
  el.innerHTML = inner;
  if (withMenu && !el.querySelector('.mdw-qt-header')) {
    el.insertAdjacentHTML('afterbegin', `<div class="mdw-qt-header">${MENU_HTML}</div>`);
  }
  return el;
}

function render(id: string, state: BlockState): HTMLElement {
  if (state.error) {
    return renderShell(id, `<div class="mdw-qt-error">${escapeHtml(state.error).replace(/\n/g, '<br>')}</div>`);
  }
  const result = state.result!;
  const { query } = parseQuery(state.text);
  const pageSize = query.page ?? result.rows.length;
  const pageCount = Math.max(1, Math.ceil(result.rows.length / pageSize));
  const page = Math.min(state.page, pageCount - 1);
  const start = page * pageSize;
  const rows = result.rows.slice(start, start + pageSize);
  const sort = query.sort[0];

  const count =
    result.total > result.rows.length
      ? `${result.rows.length} of ${result.total} files`
      : `${result.total} file${result.total === 1 ? '' : 's'}`;
  const pager =
    pageCount > 1
      ? `<span class="mdw-qt-pager">
          <button data-act="prev" ${page === 0 ? 'disabled' : ''} title="Previous page">‹</button>
          <span>${start + 1}–${Math.min(start + pageSize, result.rows.length)}</span>
          <button data-act="next" ${page >= pageCount - 1 ? 'disabled' : ''} title="Next page">›</button>
        </span>`
      : '';

  const head = result.columns
    .map((c) => {
      const active = sort?.field === c;
      const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th data-act="sort" data-field="${escapeAttr(c)}" class="${active ? 'mdw-qt-sorted' : ''}" title="Sort by ${escapeAttr(c)}">${escapeHtml(c)}${arrow}</th>`;
    })
    .join('');

  const body = rows.length
    ? rows
        .map(
          (row) =>
            `<tr data-path="${escapeAttr(row.path)}">${row.cells.map((cell) => `<td>${renderCell(cell)}</td>`).join('')}</tr>`
        )
        .join('')
    : `<tr class="mdw-qt-empty"><td colspan="${result.columns.length}">No files match</td></tr>`;

  return renderShell(
    id,
    `<div class="mdw-qt-header">${MENU_HTML}</div>
    <div class="mdw-qt-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="mdw-qt-footer">
      <span class="mdw-qt-count">${count}</span>
      ${pager}
    </div>`
  );
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
  }
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
// Interaction (delegated)

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

  const action = target.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (action) {
    e.preventDefault();
    e.stopPropagation();
    if (action !== 'menu') closeMenus();
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
        break;
      }
      case 'copy-query':
        void navigator.clipboard.writeText(state.text);
        break;
      case 'prev':
        state.page = Math.max(0, state.page - 1);
        replaceContent(root, render(id, state));
        break;
      case 'next':
        state.page += 1;
        replaceContent(root, render(id, state));
        break;
      case 'copy': {
        if (!state.result) break;
        const { query } = parseQuery(state.text);
        const pageSize = query.page ?? state.result.rows.length;
        const rows = state.result.rows.slice(state.page * pageSize, (state.page + 1) * pageSize);
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
  root.innerHTML = fresh.innerHTML;
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
    if (stream.match(/^\d{4}-\d{2}-\d{2}/)) return 'number';
    if (stream.match(/^\d+(\.\d+)?[dwmy]?\b/)) return 'number';
    const word = stream.match(/^[A-Za-z_][\w.-]*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0];
      const lower = w.toLowerCase();
      if (KEYWORDS.has(lower)) return 'keyword';
      if (OPERATORS.some((o) => o.toLowerCase() === lower)) return 'operator';
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
