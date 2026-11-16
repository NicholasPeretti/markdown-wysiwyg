/**
 * GitHub-style callouts (alerts):
 *
 *   > [!NOTE]
 *   > Useful information.
 *
 * The markdown stays a plain blockquote, so it round-trips untouched and
 * renders correctly on GitHub. Here we only decorate: the blockquote gets a
 * `mdw-callout` class per kind, and the `[!KIND]` marker is shown as a
 * title badge. Clicking the badge opens a picker to change the kind; moving
 * the cursor onto the marker reveals the raw text.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { Ctx } from '@milkdown/kit/ctx';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import {
  blockquoteSchema,
  clearTextInCurrentBlockCommand,
  wrapInBlockTypeCommand,
} from '@milkdown/kit/preset/commonmark';
import type { Crepe, CrepeFeature } from '@milkdown/crepe';

type CrepeConfig = NonNullable<ConstructorParameters<typeof Crepe>[0]>;
type SlashMenuBuilder = Parameters<
  NonNullable<
    NonNullable<NonNullable<CrepeConfig['featureConfigs']>[CrepeFeature.BlockEdit]>['buildMenu']
  >
>[0];

export const KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type Kind = (typeof KINDS)[number];

const LABELS: Record<Kind, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

const ICONS: Record<Kind, string> = {
  note: '\u24D8', // ⓘ
  tip: '\uD83D\uDCA1', // 💡
  important: '\u2757', // ❗
  warning: '\u26A0\uFE0F', // ⚠️
  caution: '\uD83D\uDED1', // 🛑
};

const MARKER_RE = /^\[!([a-zA-Z]+)\]/;

interface Marker {
  kind: Kind;
  /** Absolute document positions of the `[!KIND]` text. */
  from: number;
  to: number;
}

function markerText(kind: Kind): string {
  return `[!${kind.toUpperCase()}]`;
}

function findMarker(blockquote: ProseNode, pos: number): Marker | null {
  const first = blockquote.firstChild;
  if (!first || first.type.name !== 'paragraph') {
    return null;
  }
  const firstText = first.firstChild;
  if (!firstText?.isText || !firstText.text) {
    return null;
  }
  const match = MARKER_RE.exec(firstText.text);
  if (!match) {
    return null;
  }
  const kind = match[1].toLowerCase();
  if (!(KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  // pos is the blockquote start; +1 enters the blockquote, +1 enters the paragraph.
  const from = pos + 2;
  return { kind: kind as Kind, from, to: from + match[0].length };
}

function allMarkers(doc: ProseNode): Marker[] {
  const markers: Marker[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockquote') {
      return true;
    }
    const marker = findMarker(node, pos);
    if (marker) {
      markers.push(marker);
    }
    return false;
  });
  return markers;
}

function buildDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  const { from: selFrom, to: selTo } = state.selection;

  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'blockquote') {
      return true;
    }
    const marker = findMarker(node, pos);
    if (!marker) {
      return true;
    }
    const editing = selFrom <= marker.to && selTo >= marker.from;

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `mdw-callout mdw-callout-${marker.kind}`,
      }),
      Decoration.inline(marker.from, marker.to, {
        class: `mdw-callout-marker${editing ? ' editing' : ''}`,
        'data-label': LABELS[marker.kind],
        'data-icon': ICONS[marker.kind],
      })
    );
    return false;
  });

  return DecorationSet.create(state.doc, decorations);
}

/** Popup listing the callout kinds, anchored to a clicked title badge. */
class KindPicker {
  private el: HTMLElement | null = null;
  private onDismiss = (e: MouseEvent) => {
    if (this.el && !this.el.contains(e.target as Node)) {
      this.close();
    }
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this.close();
    }
  };

  open(view: EditorView, marker: Marker, anchor: DOMRect): void {
    this.close();
    const el = document.createElement('div');
    el.className = 'mdw-callout-popup';
    for (const kind of KINDS) {
      const item = document.createElement('div');
      item.className = `mdw-callout-item mdw-callout-${kind}${
        kind === marker.kind ? ' active' : ''
      }`;
      item.innerHTML = `<span class="mdw-callout-item-icon">${ICONS[kind]}</span><span>${LABELS[kind]}</span>`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.close();
        setKind(view, marker, kind);
      });
      el.appendChild(item);
    }
    el.style.left = `${anchor.left}px`;
    el.style.top = `${anchor.bottom + 4}px`;
    document.body.appendChild(el);
    this.el = el;
    // Defer so the opening click doesn't immediately dismiss.
    setTimeout(() => {
      document.addEventListener('mousedown', this.onDismiss, true);
      document.addEventListener('keydown', this.onKey, true);
    });
  }

  close(): void {
    this.el?.remove();
    this.el = null;
    document.removeEventListener('mousedown', this.onDismiss, true);
    document.removeEventListener('keydown', this.onKey, true);
  }
}

function setKind(view: EditorView, marker: Marker, kind: Kind): void {
  // Re-locate the marker in the current doc in case it moved.
  const current = allMarkers(view.state.doc).find((m) => m.from === marker.from) ?? marker;
  const tr = view.state.tr.insertText(markerText(kind), current.from, current.to);
  view.dispatch(tr);
}

const key = new PluginKey('mdw-callouts');

export const calloutPlugin = $prose(() => {
  const picker = new KindPicker();
  return new Plugin({
    key,
    state: {
      init: (_, state) => buildDecorations(state),
      apply: (tr, old, oldState, newState) =>
        tr.docChanged || !oldState.selection.eq(newState.selection)
          ? buildDecorations(newState)
          : old,
    },
    props: {
      decorations: (state) => key.getState(state),
      handleDOMEvents: {
        mousedown: (view, event) => {
          const target = event.target as HTMLElement | null;
          const badge = target?.closest?.('.mdw-callout-marker:not(.editing)');
          if (!badge) {
            return false;
          }
          const pos = view.posAtDOM(badge, 0);
          const marker = allMarkers(view.state.doc).find(
            (m) => pos >= m.from && pos <= m.to
          );
          if (!marker) {
            return false;
          }
          event.preventDefault();
          picker.open(view, marker, badge.getBoundingClientRect());
          return true;
        },
      },
    },
    view: () => ({ destroy: () => picker.close() }),
  });
});

/** Adds a "Callout" group to Crepe's slash menu, one item per kind. */
export function addCalloutSlashItems(builder: SlashMenuBuilder): void {
  const group = builder.addGroup('callout', 'Callout');
  for (const kind of KINDS) {
    group.addItem(kind, {
      label: `${LABELS[kind]} callout`,
      icon: `<span class="mdw-callout-slash-icon">${ICONS[kind]}</span>`,
      onRun: (ctx: Ctx) => insertCallout(ctx, kind),
    });
  }
}

function insertCallout(ctx: Ctx, kind: Kind): void {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(ctx) });

  // Put the marker in its own paragraph (`> [!TIP]\n>\n> body`): GitHub
  // renders it the same, and unlike a soft line break it survives typing.
  const view = ctx.get(editorViewCtx);
  const start = view.state.selection.$from.start();
  const text = markerText(kind);
  const tr = view.state.tr.insertText(text, start).split(start + text.length);
  tr.setSelection(TextSelection.create(tr.doc, start + text.length + 2));
  view.dispatch(tr.scrollIntoView());
}

const ESCAPED_MARKER_RE = /^(>[ \t]*)\\\[!([a-zA-Z]+)\]/gm;

/**
 * Milkdown's serializer escapes the leading `[` of a callout marker
 * (`> \[!NOTE]`), which GitHub does not recognise. Undo that escape.
 */
export function unescapeCallouts(markdown: string): string {
  return markdown.replace(ESCAPED_MARKER_RE, '$1[!$2]');
}
