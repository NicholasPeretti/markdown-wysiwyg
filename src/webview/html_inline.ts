/**
 * Inline HTML pairs such as `H<sub>2</sub>O` and `x<sup>2</sup>`.
 *
 * Milkdown keeps `<sub>` / `</sub>` as inline `html` atoms around plain text.
 * We leave the document untouched and decorate: the tags are collapsed and
 * the text between them is styled. Moving the cursor into the span reveals
 * the raw tags. Typing `<sub>text</sub>` in the editor converts the typed
 * text into real html nodes so it serializes unescaped.
 */
import { $inputRule, $prose } from '@milkdown/kit/utils';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorState } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { htmlSchema } from '@milkdown/kit/preset/commonmark';

const TAGS = ['sub', 'sup'] as const;
type Tag = (typeof TAGS)[number];

const OPEN_RE = /^<(sub|sup)>$/i;

function isHtml(node: ProseNode, value: RegExp): RegExpExecArray | null {
  return node.type.name === 'html' ? value.exec(node.attrs.value.trim()) : null;
}

interface Pair {
  tag: Tag;
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
}

function findPairs(block: ProseNode, blockPos: number): Pair[] {
  const pairs: Pair[] = [];
  let open: { tag: Tag; from: number; to: number } | null = null;

  block.forEach((child, offset) => {
    const from = blockPos + 1 + offset;
    const to = from + child.nodeSize;
    const openMatch = isHtml(child, OPEN_RE);
    if (openMatch) {
      open = { tag: openMatch[1].toLowerCase() as Tag, from, to };
      return;
    }
    if (open && isHtml(child, new RegExp(`^</${open.tag}>$`, 'i'))) {
      pairs.push({
        tag: open.tag,
        openFrom: open.from,
        openTo: open.to,
        closeFrom: from,
        closeTo: to,
      });
      open = null;
    }
  });

  return pairs;
}

function buildDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  const { from: selFrom, to: selTo } = state.selection;

  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    for (const pair of findPairs(node, pos)) {
      const editing = selFrom <= pair.closeTo && selTo >= pair.openFrom;
      const tagClass = `mdw-html-tag${editing ? ' editing' : ''}`;
      decorations.push(
        Decoration.node(pair.openFrom, pair.openTo, { class: tagClass }),
        Decoration.node(pair.closeFrom, pair.closeTo, { class: tagClass }),
        Decoration.inline(pair.openTo, pair.closeFrom, { class: `mdw-${pair.tag}` })
      );
    }
    return false;
  });

  return DecorationSet.create(state.doc, decorations);
}

const key = new PluginKey('mdw-html-inline');

export const htmlInlinePlugin = $prose(
  () =>
    new Plugin({
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
      },
    })
);

/** `<sub>text</sub>` typed as plain text becomes html(open) + text + html(close). */
export const htmlInlineInputRule = $inputRule(
  (ctx) =>
    new InputRule(/<(sub|sup)>([^<]+)<\/\1>$/i, (state, match, start, end) => {
      const [, tag, inner] = match;
      const html = htmlSchema.type(ctx);
      const lower = tag.toLowerCase();
      const { tr } = state;
      tr.replaceWith(start, end, [
        html.create({ value: `<${lower}>` }),
        state.schema.text(inner),
        html.create({ value: `</${lower}>` }),
      ]);
      return tr;
    })
);
