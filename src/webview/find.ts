/**
 * In-document find (Cmd/Ctrl+F): a VS Code-style bar at the top right with
 * the query, a "N of M" counter and prev/next, plus highlighted matches via
 * ProseMirror decorations.
 */

import { $prose } from '@milkdown/kit/utils';
import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { isPrimaryMod } from './keys';

interface Match {
  from: number;
  to: number;
}

interface FindState {
  query: string;
  matches: Match[];
  active: number;
}

interface FindMeta {
  query?: string;
  active?: number;
}

const key = new PluginKey<FindState>('mdw-find');
const EMPTY: FindState = { query: '', matches: [], active: -1 };
let onUpdate: ((state: EditorState) => void) | undefined;

export const findPlugin = $prose(
  () =>
    new Plugin<FindState>({
      key,
      state: {
        init: () => EMPTY,
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(key) as FindMeta | undefined;
          if (!meta && !tr.docChanged) return prev;
          const query = meta?.query ?? prev.query;
          if (!query) return EMPTY;
          const matches = meta?.query !== undefined || tr.docChanged ? findMatches(state.doc, query) : prev.matches;
          let active = meta?.active ?? prev.active;
          if (meta?.query !== undefined && meta.active === undefined) {
            // New query: pick the first match at or after the cursor.
            const cursor = state.selection.from;
            active = matches.findIndex((m) => m.from >= cursor);
            if (active < 0) active = matches.length ? 0 : -1;
          }
          if (matches.length === 0) active = -1;
          else active = ((active % matches.length) + matches.length) % matches.length;
          return { query, matches, active };
        },
      },
      view: () => ({
        update: (v, prev) => {
          if (v.state.doc !== prev.doc) onUpdate?.(v.state);
        },
      }),
      props: {
        decorations(state) {
          const { matches, active } = key.getState(state) ?? EMPTY;
          if (!matches.length) return null;
          return DecorationSet.create(
            state.doc,
            matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: i === active ? 'mdw-find-match mdw-find-match-active' : 'mdw-find-match',
              })
            )
          );
        },
      },
    })
);

/** Case-insensitive plain-text search over textblocks (code blocks excluded). */
function findMatches(doc: ProseNode, query: string): Match[] {
  const needle = query.toLowerCase();
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    // Each leaf is one position, so string indexes map 1:1 onto positions.
    const text = node.textBetween(0, node.content.size, undefined, '\uFFFC').toLowerCase();
    let i = text.indexOf(needle);
    while (i >= 0) {
      matches.push({ from: pos + 1 + i, to: pos + 1 + i + needle.length });
      i = text.indexOf(needle, i + Math.max(1, needle.length));
    }
    return false;
  });
  return matches;
}

// ---------------------------------------------------------------------------
// Widget

const BAR_HTML = `
  <input class="mdw-find-input" type="text" placeholder="Find" spellcheck="false" aria-label="Find" />
  <span class="mdw-find-count" aria-live="polite"></span>
  <button class="mdw-find-btn" data-find="prev" title="Previous match (⇧Enter)" aria-label="Previous match">
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.354 10.354l-.708.707L8 6.414l-4.646 4.647-.708-.707L8 5l5.354 5.354z"/></svg>
  </button>
  <button class="mdw-find-btn" data-find="next" title="Next match (Enter)" aria-label="Next match">
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2.646 5.646l.708-.707L8 9.586l4.646-4.647.708.707L8 11 2.646 5.646z"/></svg>
  </button>
  <button class="mdw-find-btn" data-find="close" title="Close (Escape)" aria-label="Close">
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>
  </button>`;

export function installFind(getCtx: () => Ctx | undefined): void {
  let bar: HTMLElement | undefined;
  let input: HTMLInputElement | undefined;
  let count: HTMLElement | undefined;

  const view = (): EditorView | undefined => {
    const ctx = getCtx();
    return ctx ? ctx.get(editorViewCtx) : undefined;
  };

  const dispatch = (meta: FindMeta): void => {
    const v = view();
    if (!v) return;
    v.dispatch(v.state.tr.setMeta(key, meta));
    sync(v.state);
    revealActive(v);
  };

  const sync = (state: EditorState): void => {
    if (!bar || !count) return;
    const s = key.getState(state) ?? EMPTY;
    const none = s.query.length > 0 && s.matches.length === 0;
    count.textContent = !s.query ? '' : none ? 'No results' : `${s.active + 1} of ${s.matches.length}`;
    bar.classList.toggle('mdw-find-none', none);
    bar.querySelectorAll<HTMLButtonElement>('[data-find="prev"],[data-find="next"]').forEach((b) => {
      b.disabled = s.matches.length === 0;
    });
  };

  const revealActive = (v: EditorView): void => {
    const s = key.getState(v.state) ?? EMPTY;
    const m = s.matches[s.active];
    if (!m) return;
    const { node } = v.domAtPos(m.from);
    const el = node instanceof Element ? node : node.parentElement;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = el?.getBoundingClientRect();
    if (rect && (rect.top < 60 || rect.bottom > window.innerHeight - 20)) {
      el?.scrollIntoView({ block: 'center' });
    }
  };

  const step = (dir: 1 | -1): void => {
    const v = view();
    if (!v) return;
    const s = key.getState(v.state) ?? EMPTY;
    if (!s.matches.length) return;
    dispatch({ active: s.active + dir });
  };

  const open = (): void => {
    const v = view();
    if (!v) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'mdw-find';
      bar.setAttribute('role', 'search');
      bar.innerHTML = BAR_HTML;
      document.body.appendChild(bar);
      input = bar.querySelector<HTMLInputElement>('.mdw-find-input')!;
      count = bar.querySelector<HTMLElement>('.mdw-find-count')!;

      input.addEventListener('input', () => dispatch({ query: input!.value }));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
        // Not stopping propagation here: VS Code reads keybindings from the
        // trusted keydown on `window`, and nothing in the editor listens to
        // keys coming from the bar anyway.
      });
      bar.addEventListener('mousedown', (e) => {
        // Keep focus in the input when clicking the bar's chrome.
        if ((e.target as HTMLElement).closest('button')) e.preventDefault();
      });
      bar.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-find]')?.dataset.find;
        if (act === 'prev') step(-1);
        else if (act === 'next') step(1);
        else if (act === 'close') close();
      });
    }
    // Seed with the selected text, as VS Code does.
    const { from, to } = v.state.selection;
    const selected = from !== to ? v.state.doc.textBetween(from, to, ' ') : '';
    bar.hidden = false;
    document.body.classList.add('mdw-find-open');
    if (selected && !selected.includes('\n') && selected.length < 200) {
      input!.value = selected;
    }
    input!.focus();
    input!.select();
    dispatch({ query: input!.value });
  };

  const close = (): void => {
    if (!bar || bar.hidden) return;
    const v = view();
    if (v) {
      const s = key.getState(v.state) ?? EMPTY;
      const m = s.matches[s.active];
      let tr = v.state.tr.setMeta(key, { query: '' });
      // Like VS Code, leave the cursor on the current match.
      if (m) tr = tr.setSelection(TextSelection.create(tr.doc, m.from, m.to));
      v.dispatch(tr);
      v.focus();
    }
    bar.hidden = true;
    document.body.classList.remove('mdw-find-open');
  };

  document.addEventListener(
    'keydown',
    (e) => {
      // Exactly the primary modifier: ⌘⌃F (full screen) and the like belong
      // to VS Code and must bubble through untouched.
      const mod = isPrimaryMod(e);
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        open();
      } else if (mod && !e.altKey && e.key.toLowerCase() === 'g' && bar && !bar.hidden) {
        e.preventDefault();
        e.stopPropagation();
        step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape' && bar && !bar.hidden && !document.querySelector('.mdw-mermaid-overlay')) {
        e.preventDefault();
        close();
      }
    },
    true
  );

  // Keep the counter in sync when the document changes under an open bar.
  onUpdate = (state) => {
    if (bar && !bar.hidden) sync(state);
  };
}
