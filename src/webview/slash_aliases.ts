/**
 * Short aliases for slash-menu items (`/h1` → Heading 1, `/ul` → bullet
 * list, …).
 *
 * Crepe filters menu items purely by `label.includes(filter)`, so the only way
 * to make an alias match is to put it in the label. We do that just for the
 * duration of an alias match, so the user sees e.g. "Heading 1 (h1)" while
 * typing `/h1`, and plain "Heading 1" the rest of the time.
 */

import type { Ctx } from '@milkdown/kit/ctx';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { SlashMenuBuilder } from './callouts';

type Builder = SlashMenuBuilder;

const ALIASES: Record<string, string[]> = {
  h1: ['h1', 'title'],
  h2: ['h2'],
  h3: ['h3'],
  h4: ['h4'],
  h5: ['h5'],
  h6: ['h6'],
  'bullet-list': ['ul', 'bullet'],
  'ordered-list': ['ol', 'numbered'],
  'task-list': ['todo', 'task', 'checkbox'],
  divider: ['hr', 'rule'],
  code: ['pre', 'snippet'],
  image: ['img', 'picture'],
  quote: ['blockquote'],
  query: ['table', 'db', 'database'],
};

export function currentSlashFilter(ctx: Ctx): string {
  let view: EditorView | undefined;
  try {
    view = ctx.get(editorViewCtx);
  } catch {
    return '';
  }
  // Before the view is ready the slice still holds its empty placeholder.
  if (!view?.state) return '';
  const text = view.state.selection.$from.parent.textContent;
  return (text.startsWith('/') ? text.slice(1) : text).trim().toLowerCase();
}

export function applySlashAliases(builder: Builder, ctx: Ctx): void {
  const filter = currentSlashFilter(ctx);
  if (filter.length < 2) return;

  for (const group of builder.build()) {
    for (const item of group.items) {
      if (item.label.toLowerCase().includes(filter)) continue;
      const alias = ALIASES[item.key]?.find((a) => a.startsWith(filter));
      if (alias) item.label = `${item.label} (${alias})`;
    }
  }
}
