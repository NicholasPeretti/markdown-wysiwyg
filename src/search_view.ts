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
}

interface ViewHit {
  key: string;
  name: string;
  title?: string;
  folder: string;
  root?: string;
  matches: { line: number; text: string }[];
}

/**
 * The "Search Notes" sidebar: a BM25 search box and per-file results with
 * their matching lines. Selecting a line opens the note in the WYSIWYG
 * editor with the query highlighted; the code button opens the source.
 */
export class SearchViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private query = '';
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly indexesFor: () => FileIndex[],
    private readonly onOpen: (req: OpenRequest) => Promise<void>
  ) {}

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
    view.webview.html = html(view.webview, this.query);
    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'search':
          this.query = String(msg.query ?? '');
          await this.run();
          break;
        case 'open': {
          const [root, rel] = String(msg.key).split('\0');
          const index = this.indexesFor().find((i) => i.folder.uri.toString() === root);
          if (!index) return;
          await this.onOpen({
            uri: vscode.Uri.joinPath(index.folder.uri, rel),
            line: typeof msg.line === 'number' ? msg.line : undefined,
            anchor: typeof msg.anchor === 'string' ? msg.anchor : undefined,
            query: this.query,
            terms: index.searchTerms(this.query),
            source: Boolean(msg.source),
          });
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
    await vscode.commands.executeCommand(`${SEARCH_VIEW_ID}.focus`);
    this.view?.webview.postMessage({ type: 'focus' });
  }

  private async run(): Promise<void> {
    const view = this.view;
    if (!view || !view.visible) return;
    const query = this.query.trim();
    if (!query) {
      view.webview.postMessage({ type: 'results', query, hits: [], terms: [] });
      return;
    }
    const indexes = this.indexesFor();
    await Promise.all(indexes.map((i) => i.ensure()));
    if (query !== this.query.trim()) return;
    const multi = indexes.length > 1;
    const hits = indexes
      .flatMap((index) => index.find(query, 50).map((hit) => ({ hit, index })))
      .sort((a, b) => b.hit.score - a.hit.score)
      .slice(0, 50)
      .map(({ hit, index }) => toView(hit, index, multi));
    view.webview.postMessage({ type: 'results', query, hits, terms: indexes[0]?.searchTerms(query) ?? [] });
  }
}

function toView(hit: SearchResult, index: FileIndex, multi: boolean): ViewHit {
  return {
    key: `${index.folder.uri.toString()}\0${hit.path}`,
    name: hit.name,
    title: hit.title,
    folder: hit.folder,
    root: multi ? index.folder.name : undefined,
    matches: hit.matches.map(({ line, text }) => ({ line, text })),
  };
}

function html(webview: vscode.Webview, initial: string): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-sideBar-background);
  }
  .box { position: sticky; top: 0; padding: 8px 12px 6px; background: var(--vscode-sideBar-background); z-index: 1; }
  input {
    width: 100%; box-sizing: border-box; padding: 4px 6px;
    font: inherit; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none;
  }
  input:focus { border-color: var(--vscode-focusBorder); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .status { padding: 2px 12px 8px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .hit { padding: 6px 0 10px; }
  .hit + .hit { border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.2)); }
  .head { display: flex; align-items: baseline; gap: 8px; padding: 4px 12px; cursor: pointer; border-radius: 3px; margin: 0 4px; }
  .head:hover, .line:hover { background: var(--vscode-list-hoverBackground); }
  .head:focus-visible, .line:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folder { color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
  .folder:empty { display: none; }
  .src {
    flex: none; opacity: 0; border: 0; background: none; color: inherit; cursor: pointer;
    padding: 0 2px; font: inherit; font-size: 0.9em; line-height: 1;
  }
  .head:hover .src, .src:focus-visible { opacity: 0.8; }
  .src:hover { opacity: 1 !important; }
  .line {
    display: block; padding: 3px 12px 3px 28px; margin: 0 4px; cursor: pointer; border-radius: 3px;
    color: var(--vscode-foreground); opacity: 0.85;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .line b {
    font-weight: normal; border-radius: 2px;
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.33));
    color: var(--vscode-editor-foreground, inherit);
  }
  .empty { padding: 16px 12px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="box"><input id="q" type="search" autofocus placeholder="Search notes" autocomplete="off" spellcheck="false" value="${escapeAttr(initial)}"></div>
  <div class="status" id="status"></div>
  <div id="results"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const results = document.getElementById('results');
  const status = document.getElementById('status');
  let timer;
  let terms = [];
  const send = () => vscode.postMessage({ type: 'search', query: q.value });
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(send, 60); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) { q.value = ''; send(); e.preventDefault(); }
    if (e.key === 'ArrowDown') { results.querySelector('[tabindex]')?.focus(); e.preventDefault(); }
    if (e.key === 'Enter') { results.querySelector('.head')?.click(); }
  });
  results.addEventListener('keydown', (e) => {
    const items = [...results.querySelectorAll('[tabindex]')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown') { (items[i + 1] ?? items[i]).focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { (items[i - 1] ?? q).focus(); e.preventDefault(); }
    else if (e.key === 'Enter') { document.activeElement.click(); e.preventDefault(); }
  });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'focus') { q.focus(); q.select(); return; }
    if (m.type !== 'results') return;
    render(m.query, m.hits, m.terms);
  });
  function mark(text) {
    if (!terms.length) return esc(text);
    const re = new RegExp('(?<![\\\\p{L}\\\\p{N}_])(' + terms.map(reEsc).join('|') + ')', 'giu');
    let out = '', last = 0;
    for (const m of text.matchAll(re)) {
      out += esc(text.slice(last, m.index)) + '<b>' + esc(m[0]) + '</b>';
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }
  function render(query, hits, t) {
    terms = t;
    results.replaceChildren();
    if (!query) { status.textContent = ''; return; }
    status.textContent = hits.length ? hits.length + (hits.length === 50 ? '+' : '') + ' notes' : '';
    if (!hits.length) {
      const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'No notes match every word.';
      results.append(d); return;
    }
    for (const hit of hits) {
      const el = document.createElement('div'); el.className = 'hit';
      const where = [hit.root, hit.folder].filter(Boolean).join(' › ');
      el.innerHTML =
        '<div class="head" tabindex="0" title="' + escAttr([hit.name + '.md', where].filter(Boolean).join(' — ')) + '">' +
          '<span class="name">' + esc(hit.title || hit.name) + '</span>' +
          '<span class="folder">' + esc(where) + '</span>' +
          '<button class="src" title="Open source">&lt;/&gt;</button>' +
        '</div>' +
        hit.matches.map((m) => '<a class="line" tabindex="0" data-line="' + m.line + '" title="Line ' + (m.line + 1) + '">' + mark(m.text) + '</a>').join('');
      el.querySelector('.head').addEventListener('click', (e) => {
        const source = e.target.closest('.src') !== null;
        vscode.postMessage({ type: 'open', key: hit.key, source, line: hit.matches[0]?.line });
      });
      el.querySelectorAll('.line').forEach((a, i) => a.addEventListener('click', (e) => {
        vscode.postMessage({ type: 'open', key: hit.key, source: e.altKey, line: hit.matches[i].line, anchor: hit.matches[i].text });
      }));
      results.append(el);
    }
  }
  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function reEsc(s) { return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }
  if (q.value) send();
</script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
