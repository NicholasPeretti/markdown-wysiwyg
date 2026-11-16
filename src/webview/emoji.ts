/**
 * GitHub-style emoji support:
 * - Typing `:` followed by 2+ characters opens an autocomplete popup.
 * - Typing a complete shortcode like `:smile:` replaces it with the emoji.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { gemoji } from 'gemoji';

interface EmojiItem {
  name: string;
  emoji: string;
}

const ALL_EMOJI: EmojiItem[] = gemoji.flatMap((g) =>
  g.names.map((name) => ({ name, emoji: g.emoji }))
);
const BY_NAME = new Map(ALL_EMOJI.map((item) => [item.name, item.emoji]));

const QUERY_RE = /(?:^|[\s([{]):([a-zA-Z0-9_+-]{2,})$/;
const COMPLETE_RE = /(?:^|[\s([{]):([a-zA-Z0-9_+-]+):$/;
const MAX_RESULTS = 8;

function search(query: string): EmojiItem[] {
  const q = query.toLowerCase();
  const prefix: EmojiItem[] = [];
  const substring: EmojiItem[] = [];
  for (const item of ALL_EMOJI) {
    if (item.name.startsWith(q)) {
      prefix.push(item);
    } else if (item.name.includes(q)) {
      substring.push(item);
    }
    if (prefix.length >= MAX_RESULTS) {
      break;
    }
  }
  return [...prefix, ...substring].slice(0, MAX_RESULTS);
}

/** Text immediately before the cursor within its text block. */
function textBeforeCursor(view: EditorView): string | null {
  const { $from, empty } = view.state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) {
    return null;
  }
  return $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 50),
    $from.parentOffset,
    undefined,
    '\ufffc'
  );
}

class EmojiPopup {
  private el: HTMLElement;
  private items: EmojiItem[] = [];
  private selected = 0;
  private range: { from: number; to: number } | null = null;
  private dismissed = false;

  constructor(private view: EditorView) {
    this.el = document.createElement('div');
    this.el.className = 'mdw-emoji-popup';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
  }

  get open(): boolean {
    return this.el.style.display !== 'none';
  }

  update(view: EditorView): void {
    this.view = view;
    const text = textBeforeCursor(view);
    const match = text === null ? null : QUERY_RE.exec(text);

    if (!match) {
      this.dismissed = false;
      this.hide();
      return;
    }
    if (this.dismissed) {
      return;
    }

    const query = match[1];
    this.items = search(query);
    if (this.items.length === 0) {
      this.hide();
      return;
    }

    const to = view.state.selection.from;
    this.range = { from: to - query.length - 1, to };
    this.selected = Math.min(this.selected, this.items.length - 1);
    this.render();
    this.position();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this.open) {
      return false;
    }
    switch (event.key) {
      case 'ArrowDown':
        this.selected = (this.selected + 1) % this.items.length;
        this.render();
        return true;
      case 'ArrowUp':
        this.selected = (this.selected - 1 + this.items.length) % this.items.length;
        this.render();
        return true;
      case 'Enter':
      case 'Tab':
        this.commit(this.items[this.selected]);
        return true;
      case 'Escape':
        this.dismissed = true;
        this.hide();
        return true;
      default:
        return false;
    }
  }

  destroy(): void {
    this.el.remove();
  }

  private commit(item: EmojiItem): void {
    if (!this.range) {
      return;
    }
    const tr = this.view.state.tr.insertText(item.emoji, this.range.from, this.range.to);
    this.view.dispatch(tr);
    this.hide();
    this.view.focus();
  }

  private render(): void {
    this.el.replaceChildren(
      ...this.items.map((item, i) => {
        const row = document.createElement('div');
        row.className = 'mdw-emoji-item' + (i === this.selected ? ' active' : '');
        const icon = document.createElement('span');
        icon.className = 'mdw-emoji-icon';
        icon.textContent = item.emoji;
        const name = document.createElement('span');
        name.textContent = `:${item.name}:`;
        row.append(icon, name);
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.commit(item);
        });
        return row;
      })
    );
    this.el.style.display = 'block';
  }

  private position(): void {
    if (!this.range) {
      return;
    }
    const coords = this.view.coordsAtPos(this.range.from);
    const rect = this.el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - coords.bottom;
    const left = Math.min(coords.left, window.innerWidth - rect.width - 8);
    this.el.style.left = `${Math.max(8, left)}px`;
    if (spaceBelow < rect.height + 8) {
      this.el.style.top = `${coords.top - rect.height - 4}px`;
    } else {
      this.el.style.top = `${coords.bottom + 4}px`;
    }
  }

  private hide(): void {
    this.el.style.display = 'none';
    this.range = null;
    this.selected = 0;
  }
}

export const emojiPlugin = $prose(() => {
  let popup: EmojiPopup | undefined;
  return new Plugin({
    key: new PluginKey('mdw-emoji'),
    view: (editorView) => {
      popup = new EmojiPopup(editorView);
      return {
        update: (view) => popup?.update(view),
        destroy: () => {
          popup?.destroy();
          popup = undefined;
        },
      };
    },
    props: {
      handleKeyDown: (_view, event) => popup?.handleKeyDown(event) ?? false,
    },
    // Replace a fully typed `:shortcode:` with its emoji.
    appendTransaction: (transactions, _oldState, newState) => {
      if (!transactions.some((tr) => tr.docChanged)) {
        return null;
      }
      const { $from, empty } = newState.selection;
      if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) {
        return null;
      }
      const text = $from.parent.textBetween(
        Math.max(0, $from.parentOffset - 50),
        $from.parentOffset,
        undefined,
        '\ufffc'
      );
      const match = COMPLETE_RE.exec(text);
      if (!match) {
        return null;
      }
      const emoji = BY_NAME.get(match[1]);
      if (!emoji) {
        return null;
      }
      const to = newState.selection.from;
      const from = to - match[1].length - 2;
      return newState.tr.insertText(emoji, from, to);
    },
  });
});
