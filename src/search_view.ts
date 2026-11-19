import * as vscode from 'vscode';
import type { FileIndex, SearchResult } from './query/host';

export const SEARCH_VIEW_ID = 'markdownWysiwyg.searchView';

export interface OpenRequest {
  uri: vscode.Uri;
  /** 0-based line of the clicked match, if any. */
  line?: number;
  /** Text of the clicked line, used to land the find bar on it. */
  anchor?: string;
  query: string;
  terms: string[];
  source: boolean;
  /** Keep focus in the search view (keyboard cycling). */
  preserveFocus?: boolean;
}

interface ViewMatch {
  line: number;
  text: string;
}

interface ViewHit {
  key: string;
  name: string;
  title?: string;
  /** Workspace-relative path of the file. */
  path: string;
  root?: string;
  matches: ViewMatch[];
  matchCount: number;
}

/**
 * The "Search Notes" sidebar, modelled on VS Code's Search view: a query box,
 * "N results in M files", results as a flat list or a folder tree with match
 * badges, collapsible files, keyboard navigation and F4 cycling.
 */
export class SearchViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private query = '';
  private tree: boolean;
  private collapsed = false;
  /** Flat list of result lines in display order, for F4 cycling. */
  private results: { hit: ViewHit; match: ViewMatch; index: FileIndex }[] = [];
  private cursor = -1;
  private focusPending = false;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly state: vscode.Memento,
    private readonly indexesFor: () => FileIndex[],
    private readonly onOpen: (req: OpenRequest) => Promise<void>
  ) {
    this.tree = state.get('searchTree', false);
    void vscode.commands.executeCommand('setContext', 'markdownWysiwyg.searchTree', this.tree);
    void vscode.commands.executeCommand('setContext', 'markdownWysiwyg.hasSearchResults', false);
    this.subs.push(
      vscode.commands.registerCommand('markdownWysiwyg.searchViewAsTree', () => this.setTree(true)),
      vscode.commands.registerCommand('markdownWysiwyg.searchViewAsList', () => this.setTree(false)),
      vscode.commands.registerCommand('markdownWysiwyg.searchCollapseAll', () => this.setCollapsed(true)),
      vscode.commands.registerCommand('markdownWysiwyg.searchExpandAll', () => this.setCollapsed(false)),
      vscode.commands.registerCommand('markdownWysiwyg.searchClear', () => this.clear()),
      vscode.commands.registerCommand('markdownWysiwyg.searchNext', () => this.step(1)),
      vscode.commands.registerCommand('markdownWysiwyg.searchPrevious', () => this.step(-1))
    );
  }

  /** Call when an index is created so result lists follow file changes. */
  watch(index: FileIndex): void {
    this.subs.push(index.onDidChange(() => this.run()));
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);
    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this.post({ type: 'state', query: this.query, tree: this.tree, collapsed: this.collapsed });
          if (this.focusPending) {
            this.focusPending = false;
            this.post({ type: 'focus' });
          }
          await this.run();
          break;
        case 'search':
          this.query = String(msg.query ?? '');
          this.cursor = -1;
          await this.run();
          break;
        case 'collapsed':
          this.collapsed = Boolean(msg.value);
          void vscode.commands.executeCommand('setContext', 'markdownWysiwyg.searchCollapsed', this.collapsed);
          break;
        case 'open': {
          const i = Number(msg.index);
          const r = this.results[i];
          if (!r) {
            // A file header: open at its first match.
            const hit = this.results.find((x) => x.hit.key === msg.key);
            if (hit) await this.openResult(this.results.indexOf(hit), Boolean(msg.source), false, true);
            return;
          }
          await this.openResult(i, Boolean(msg.source), Boolean(msg.preserveFocus), Boolean(msg.anchor));
          break;
        }
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.run();
    });
  }

  /** Reveals the view and focuses its input. */
  async focus(): Promise<void> {
    this.focusPending = !this.view;
    await vscode.commands.executeCommand(`${SEARCH_VIEW_ID}.focus`);
    if (this.view) this.post({ type: 'focus' });
  }

  private post(msg: object): void {
    void this.view?.webview.postMessage(msg);
  }

  private setTree(tree: boolean): void {
    this.tree = tree;
    void this.state.update('searchTree', tree);
    void vscode.commands.executeCommand('setContext', 'markdownWysiwyg.searchTree', tree);
    this.post({ type: 'state', tree });
    void this.run();
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    void vscode.commands.executeCommand('setContext', 'markdownWysiwyg.searchCollapsed', collapsed);
    this.post({ type: 'state', collapsed });
  }

  private clear(): void {
    this.query = '';
    this.post({ type: 'state', query: '' });
    void this.run();
  }

  /** F4 / ⇧F4: opens the next or previous result line, wrapping around. */
  private async step(delta: number): Promise<void> {
    if (!this.results.length) return;
    const n = this.results.length;
    this.cursor = ((this.cursor + delta) % n + n) % n;
    await this.openResult(this.cursor, false, true, true);
  }

  private async openResult(index: number, source: boolean, preserveFocus: boolean, anchor: boolean): Promise<void> {
    const r = this.results[index];
    if (!r) return;
    this.cursor = index;
    this.post({ type: 'select', index });
    await this.onOpen({
      uri: vscode.Uri.joinPath(r.index.folder.uri, r.hit.path),
      line: r.match.line,
      anchor: anchor ? r.match.text : undefined,
      query: this.query,
      terms: r.index.searchTerms(this.query),
      source,
      preserveFocus,
    });
  }

  private async run(): Promise<void> {
    const query = this.query.trim();
    if (!query) {
      this.results = [];
      void vscode.commands.executeCommand('setContext', 'markdownWysiwyg.hasSearchResults', false);
      this.post({ type: 'results', query, hits: [], terms: [] });
      return;
    }
    const indexes = this.indexesFor();
    await Promise.all(indexes.map((i) => i.ensure()));
    if (query !== this.query.trim()) return;
    const multi = indexes.length > 1;
    const ranked = indexes
      .flatMap((index) => index.find(query, 100).map((hit) => ({ hit, index })))
      .sort((a, b) => b.hit.score - a.hit.score)
      .slice(0, 100)
      .map(({ hit, index }) => ({ hit: toView(hit, index, multi), index }));
    if (this.tree) ranked.sort((a, b) => a.hit.path.localeCompare(b.hit.path));
    this.results = ranked.flatMap(({ hit, index }) => hit.matches.map((match) => ({ hit, match, index })));
    this.cursor = -1;
    void vscode.commands.executeCommand('setContext', 'markdownWysiwyg.hasSearchResults', this.results.length > 0);
    this.post({
      type: 'results',
      query,
      hits: ranked.map((r) => r.hit),
      terms: indexes[0]?.searchTerms(query) ?? [],
    });
  }
}

function toView(hit: SearchResult, index: FileIndex, multi: boolean): ViewHit {
  const matches = hit.matches.length ? hit.matches : [{ line: 0, text: hit.title ?? hit.name, hits: 0 }];
  return {
    key: `${index.folder.uri.toString()}\0${hit.path}`,
    name: hit.name,
    title: hit.title,
    path: hit.path,
    root: multi ? index.folder.name : undefined,
    matches: matches.map(({ line, text }) => ({ line, text })),
    matchCount: Math.max(hit.matchCount, 1),
  };
}

function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; --row: 22px; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 0; user-select: none; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-sideBar-foreground, var(--vscode-foreground)); background: var(--vscode-sideBar-background);
  }
  .box { flex: none; padding: 6px 12px 4px 20px; }
  input {
    width: 100%; box-sizing: border-box; padding: 3px 6px; height: 26px;
    font: inherit; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  input:focus { border-color: var(--vscode-focusBorder); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .status { flex: none; padding: 4px 12px 6px 20px; color: var(--vscode-descriptionForeground); min-height: 1.3em; }
  .status.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #results { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-bottom: 12px; outline: none; }
  /* Folder and file rows stick while their children scroll, stacked by depth. */
  .node > .row { position: sticky; z-index: 1; background: var(--vscode-sideBar-background); }
  .node > .row:hover { background: var(--vscode-list-hoverBackground); }
  .icon { flex: none; width: 16px; height: 16px; }
  .row {
    display: flex; align-items: center; gap: 6px; height: var(--row); line-height: var(--row);
    padding-right: 10px; cursor: pointer; white-space: nowrap; position: relative;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  #results:focus .row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px solid var(--vscode-list-focusOutline, var(--vscode-focusBorder)); outline-offset: -1px; }
  #results:not(:focus) .row.sel { background: var(--vscode-list-inactiveSelectionBackground); }
  .twistie { flex: none; width: 16px; height: 16px; position: relative; }
  .twistie::before {
    content: ''; position: absolute; left: 4px; top: 3px; width: 6px; height: 6px;
    border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
    transform: rotate(45deg); opacity: 0.9;
  }
  .collapsed > .row .twistie::before { left: 3px; top: 5px; transform: rotate(-45deg); }
  .collapsed > .children { display: none; }
  .label { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 2ch; }
  .desc { color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; direction: rtl; text-align: left; }
  .desc bdi { unicode-bidi: plaintext; }
  #results:focus .row.sel .desc { color: inherit; opacity: 0.85; }
  .badge {
    flex: none; min-width: 18px; height: 18px; line-height: 18px; padding: 0 5px; box-sizing: border-box;
    border-radius: 9px; text-align: center; font-size: 11px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .row .src {
    flex: none; display: none; border: 0; background: none; color: inherit; cursor: pointer;
    font: inherit; font-size: 11px; opacity: 0.8; padding: 0 3px; line-height: 1;
  }
  .row:hover .src, .row.sel .src { display: inline-block; }
  .src:hover { opacity: 1; }
  .match .label { opacity: 0.9; }
  .match b {
    font-weight: normal; border-radius: 2px;
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.33));
    color: var(--vscode-editor-foreground, inherit);
  }
  .more { color: var(--vscode-descriptionForeground); font-style: italic; }
  .empty { padding: 8px 12px 8px 20px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="box"><input id="q" type="search" placeholder="Search notes (⌘⇧⌥F)" autocomplete="off" spellcheck="false" autofocus></div>
  <div class="status ellipsis" id="status"></div>
  <div id="results" tabindex="0"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const results = document.getElementById('results');
  const status = document.getElementById('status');
  let timer, terms = [], tree = false, collapsed = false, hits = [], query = '';
  // Seti-style markdown file icon, as used by VS Code's own Search view.
  const MD_ICON = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M1.5 12V4.5l3 3.8 3-3.8V12" fill="none" stroke="#519aba" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<path d="M12 4v7.5M9.6 9.2l2.4 2.4 2.4-2.4" fill="none" stroke="#519aba" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let rows = [];        // visible rows in order (elements)
  let sel = -1;         // index into rows
  const send = () => vscode.postMessage({ type: 'search', query: q.value });

  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(send, 60); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) { q.value = ''; send(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { focusRows(0); e.preventDefault(); }
    else if (e.key === 'Enter') { const r = rows.find((x) => x.dataset.index !== undefined); if (r) open(r, e); }
  });

  results.addEventListener('keydown', (e) => {
    const n = rows.length;
    if (!n) return;
    const row = rows[sel];
    const node = row?.parentElement;
    switch (e.key) {
      case 'ArrowDown': select(sel + 1 >= n ? 0 : sel + 1); break;
      case 'ArrowUp': if (sel <= 0) { q.focus(); q.select(); } else select(sel - 1); break;
      case 'Home': select(0); break;
      case 'End': select(n - 1); break;
      case 'PageDown': select(Math.min(n - 1, sel + 10)); break;
      case 'PageUp': select(Math.max(0, sel - 10)); break;
      case 'ArrowRight':
        if (node?.classList.contains('node') && node.classList.contains('collapsed')) toggle(node);
        else if (node?.classList.contains('node')) select(sel + 1 < n ? sel + 1 : sel);
        break;
      case 'ArrowLeft':
        if (node?.classList.contains('node') && !node.classList.contains('collapsed')) toggle(node);
        else { const p = node?.parentElement?.closest('.node'); if (p) select(rows.indexOf(p.firstElementChild)); }
        break;
      case ' ': if (node?.classList.contains('node')) toggle(node); break;
      case 'Enter': if (row) open(row, e, false); break;
      case 'Escape': q.focus(); q.select(); break;
      default: return;
    }
    e.preventDefault();
  });
  results.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    select(rows.indexOf(row), false);
    if (e.target.closest('.src')) { open(row, e, true, true); return; }
    if (row.parentElement.classList.contains('node') && !row.dataset.index) {
      // Folder rows toggle; file rows open at first match and also toggle on twistie.
      if (row.dataset.kind === 'folder' || e.target.closest('.twistie')) { toggle(row.parentElement); return; }
    }
    open(row, e, false, true);
  });
  results.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row) open(row, e, false, false);
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'focus') { q.focus(); q.select(); return; }
    if (m.type === 'state') {
      if (m.query !== undefined) q.value = m.query;
      if (m.tree !== undefined) tree = m.tree;
      if (m.collapsed !== undefined) { collapsed = m.collapsed; document.querySelectorAll('.node').forEach((n) => n.classList.toggle('collapsed', collapsed)); refreshRows(); }
      return;
    }
    if (m.type === 'select') { const r = rows.find((x) => Number(x.dataset.index) === m.index); if (r) select(rows.indexOf(r), false); return; }
    if (m.type === 'results') { query = m.query; hits = m.hits; terms = m.terms; render(); }
  });

  function focusRows(i) { results.focus(); select(i); }
  function select(i, scroll = true) {
    rows[sel]?.classList.remove('sel');
    sel = Math.max(-1, Math.min(rows.length - 1, i));
    const row = rows[sel];
    if (row) { row.classList.add('sel'); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
  }
  function toggle(node) {
    node.classList.toggle('collapsed');
    const anyOpen = [...document.querySelectorAll('.node')].some((n) => !n.classList.contains('collapsed'));
    collapsed = !anyOpen;
    vscode.postMessage({ type: 'collapsed', value: collapsed });
    refreshRows();
  }
  function refreshRows() {
    const prev = rows[sel];
    rows = [...results.querySelectorAll('.row')].filter((r) => !r.closest('.collapsed > .children'));
    sel = rows.indexOf(prev);
    if (sel < 0 && prev) { prev.classList.remove('sel'); }
  }
  function open(row, e, source = e.altKey, preserveFocus = true) {
    const idx = row.dataset.index;
    if (idx !== undefined) vscode.postMessage({ type: 'open', index: Number(idx), source, preserveFocus, anchor: true });
    else if (row.dataset.key) vscode.postMessage({ type: 'open', key: row.dataset.key, source, preserveFocus });
  }

  function mark(text) {
    if (!terms.length) return esc(text);
    const re = new RegExp('(?<![\\\\p{L}\\\\p{N}_])(' + terms.map(reEsc).join('|') + ')[\\\\p{L}\\\\p{N}_]*', 'giu');
    let out = '', last = 0;
    for (const m of text.matchAll(re)) {
      out += esc(text.slice(last, m.index)) + '<b>' + esc(m[0]) + '</b>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  function render() {
    results.replaceChildren();
    rows = []; sel = -1;
    if (!query) { status.textContent = ''; return; }
    const total = hits.reduce((n, h) => n + h.matchCount, 0);
    status.textContent = hits.length
      ? plural(total, 'result') + ' in ' + plural(hits.length, 'file') + (hits.length === 100 ? ' (top 100)' : '')
      : 'No results found. Every word must match.';
    if (!hits.length) return;
    let index = 0;
    const file = (hit, depth, showPath) => {
      const node = el('div', 'node' + (collapsed ? ' collapsed' : ''));
      const row = el('div', 'row');
      row.dataset.key = hit.key;
      row.style.paddingLeft = (8 + depth * 8) + 'px';
      row.style.top = 'calc(' + depth + ' * var(--row))';
      row.style.scrollMarginTop = row.style.top;
      const where = [hit.root, dirOf(hit.path)].filter(Boolean).join('/');
      row.title = (hit.root ? hit.root + '/' : '') + hit.path + (hit.title && hit.title !== hit.name ? '\\n' + hit.title : '');
      row.innerHTML = '<span class="twistie"></span>' + MD_ICON +
        '<span class="label">' + esc(hit.name + '.md') + '</span>' +
        (showPath && where ? '<span class="desc"><bdi>' + esc(where) + '</bdi></span>' : '<span class="desc"></span>') +
        '<button class="src" title="Open source">&lt;/&gt;</button>' +
        '<span class="badge">' + hit.matchCount + '</span>';
      node.append(row);
      const children = el('div', 'children');
      for (const m of hit.matches) {
        const r = el('div', 'row match');
        r.dataset.index = String(index++);
        r.style.paddingLeft = (8 + (depth + 1) * 8 + 16) + 'px';
        r.style.scrollMarginTop = 'calc(' + (depth + 1) + ' * var(--row))';
        r.title = 'Line ' + (m.line + 1);
        r.innerHTML = '<span class="label">' + mark(m.text) + '</span><span class="desc"></span><button class="src" title="Open source at line">&lt;/&gt;</button>';
        children.append(r);
      }
      if (hit.matchCount > hit.matches.length) {
        const r = el('div', 'row more');
        r.style.paddingLeft = (8 + (depth + 1) * 8 + 16) + 'px';
        r.style.scrollMarginTop = 'calc(' + (depth + 1) + ' * var(--row))';
        r.dataset.key = hit.key;
        r.textContent = '+' + (hit.matchCount - hit.matches.length) + ' more…';
        children.append(r);
      }
      node.append(children);
      return node;
    };
    if (!tree) {
      for (const hit of hits) results.append(file(hit, 0, true));
    } else {
      // Build a folder tree, compressing single-child folders like VS Code.
      const root = { dirs: new Map(), files: [] };
      for (const hit of hits) {
        const parts = [hit.root, ...dirOf(hit.path).split('/')].filter(Boolean);
        let cur = root;
        for (const p of parts) { if (!cur.dirs.has(p)) cur.dirs.set(p, { dirs: new Map(), files: [] }); cur = cur.dirs.get(p); }
        cur.files.push(hit);
      }
      const count = (d) => d.files.reduce((n, h) => n + h.matchCount, 0) + [...d.dirs.values()].reduce((n, c) => n + count(c), 0);
      const emit = (dir, name, depth, parent) => {
        let label = name, d = dir;
        while (d.files.length === 0 && d.dirs.size === 1) { const [k, v] = [...d.dirs][0]; label = label ? label + '/' + k : k; d = v; }
        const node = el('div', 'node' + (collapsed ? ' collapsed' : ''));
        const row = el('div', 'row');
        row.dataset.kind = 'folder';
        row.style.paddingLeft = (8 + depth * 8) + 'px';
        row.style.top = 'calc(' + depth + ' * var(--row))';
        row.style.scrollMarginTop = row.style.top;
        row.title = label;
        row.innerHTML = '<span class="twistie"></span><span class="label">' + esc(label) + '</span><span class="badge">' + count(d) + '</span><span class="desc"></span>';
        node.append(row);
        const children = el('div', 'children');
        for (const [k, v] of [...d.dirs].sort((a, b) => a[0].localeCompare(b[0]))) emit(v, k, depth + 1, children);
        for (const h of d.files) children.append(file(h, depth + 1, false));
        node.append(children);
        parent.append(node);
      };
      for (const [k, v] of [...root.dirs].sort((a, b) => a[0].localeCompare(b[0]))) emit(v, k, 0, results);
      for (const h of root.files) results.append(file(h, 0, false));
    }
    refreshRows();
  }
  function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }
  function reEsc(s) { return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }
  window.addEventListener('focus', () => {
    if (document.activeElement === document.body) q.focus();
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
