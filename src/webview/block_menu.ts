/**
 * Block menu: clicking the grip of Crepe's block handle opens a Notion-like
 * menu for the hovered block with "Turn into" (text, headings, lists, quote,
 * code) and "Delete".
 *
 * Crepe's block service already turns a mousedown on the handle into a
 * NodeSelection of the hovered block (that is what makes dragging work), so
 * by the time the click fires the selection tells us which block to act on.
 */

import type { EditorView } from '@milkdown/kit/prose/view';
import { Fragment, type Node as ProseNode, type Schema } from '@milkdown/kit/prose/model';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';

type Target = 'paragraph' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'task' | 'quote' | 'code';

interface Item {
  target: Target;
  label: string;
  icon: string;
}

const ITEMS: Item[] = [
  { target: 'paragraph', label: 'Text', icon: '¶' },
  { target: 'h1', label: 'Heading 1', icon: 'H1' },
  { target: 'h2', label: 'Heading 2', icon: 'H2' },
  { target: 'h3', label: 'Heading 3', icon: 'H3' },
  { target: 'bullet', label: 'Bullet list', icon: '•' },
  { target: 'ordered', label: 'Numbered list', icon: '1.' },
  { target: 'task', label: 'Task list', icon: '☑' },
  { target: 'quote', label: 'Quote', icon: '❝' },
  { target: 'code', label: 'Code', icon: '<>' },
];

const LIST_TARGETS = new Set<Target>(['bullet', 'ordered', 'task']);

const GRIP_SELECTOR = '.milkdown-block-handle .operation-item:last-child';

/** What `node` currently is, in menu terms, or null when it has no equivalent. */
function currentTarget(node: ProseNode): Target | null {
  switch (node.type.name) {
    case 'paragraph':
      return 'paragraph';
    case 'heading':
      return node.attrs.level <= 3 ? (`h${node.attrs.level}` as Target) : null;
    case 'ordered_list':
      return 'ordered';
    case 'bullet_list':
      return node.firstChild?.attrs.checked != null ? 'task' : 'bullet';
    case 'list_item':
      return node.attrs.checked != null ? 'task' : node.attrs.listType === 'ordered' ? 'ordered' : 'bullet';
    case 'blockquote':
      return 'quote';
    case 'code_block':
      return 'code';
    default:
      return null;
  }
}

/** Flattens `node` into the inline content of each textblock it contains. */
function inlineBlocks(node: ProseNode): Fragment[] {
  if (node.isTextblock) return [node.content];
  const out: Fragment[] = [];
  node.forEach((child) => out.push(...inlineBlocks(child)));
  return out;
}

function listItemAttrs(schema: Schema, target: Target, index: number): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    label: target === 'ordered' ? `${index + 1}.` : '•',
    listType: target === 'ordered' ? 'ordered' : 'bullet',
  };
  if ('checked' in schema.nodes.list_item.spec.attrs!) attrs.checked = target === 'task' ? false : null;
  return attrs;
}

/** Builds the replacement for `blocks` as `target`. */
function build(schema: Schema, target: Target, blocks: Fragment[]): ProseNode[] {
  const n = schema.nodes;
  if (blocks.length === 0) blocks = [Fragment.empty];
  const paragraphs = () => blocks.map((b) => n.paragraph.create(null, b));
  switch (target) {
    case 'paragraph':
      return paragraphs();
    case 'h1':
    case 'h2':
    case 'h3':
      return blocks.map((b) => n.heading.create({ level: Number(target[1]) }, b));
    case 'bullet':
    case 'ordered':
    case 'task': {
      const items = blocks.map((b, i) => n.list_item.create(listItemAttrs(schema, target, i), n.paragraph.create(null, b)));
      return [(target === 'ordered' ? n.ordered_list : n.bullet_list).create(null, items)];
    }
    case 'quote':
      return [n.blockquote.create(null, paragraphs())];
    case 'code': {
      const text = blocks.map((b) => b.textBetween(0, b.size, '\n', '')).join('\n');
      return [n.code_block.create(null, text ? schema.text(text) : null)];
    }
  }
}

/** Positions of the direct children of the node at `pos`. */
function childPositions(node: ProseNode, pos: number): number[] {
  const out: number[] = [];
  let p = pos + 1;
  node.forEach((child) => {
    out.push(p);
    p += child.nodeSize;
  });
  return out;
}

function turnInto(view: EditorView, sel: NodeSelection, target: Target): void {
  const { node, from, to } = sel;
  const { schema } = view.state;
  const tr = view.state.tr;
  const $pos = tr.doc.resolve(from);
  const isList = node.type.name === 'bullet_list' || node.type.name === 'ordered_list';

  if (LIST_TARGETS.has(target) && isList) {
    // Retype the whole list in place so nesting survives.
    const listType = target === 'ordered' ? schema.nodes.ordered_list : schema.nodes.bullet_list;
    tr.setNodeMarkup(from, listType, listType === node.type ? node.attrs : null);
    childPositions(node, from).forEach((p, i) => {
      const item = tr.doc.nodeAt(p)!;
      tr.setNodeMarkup(p, undefined, { ...item.attrs, ...listItemAttrs(schema, target, i) });
    });
  } else if (node.type.name === 'list_item') {
    const list = $pos.parent;
    const sameKind =
      LIST_TARGETS.has(target) && (target === 'ordered') === (list.type.name === 'ordered_list');
    if (sameKind) {
      tr.setNodeMarkup(from, undefined, { ...node.attrs, ...listItemAttrs(schema, target, $pos.index()) });
    } else {
      // Split the list around the item and replace just that item.
      const listPos = $pos.before();
      const offset = $pos.parentOffset;
      const before = list.content.cut(0, offset);
      const after = list.content.cut(offset + node.nodeSize);
      const out: ProseNode[] = [];
      if (before.size) out.push(list.copy(before));
      out.push(...build(schema, target, inlineBlocks(node)));
      if (after.size) out.push(list.copy(after));
      tr.replaceWith(listPos, listPos + list.nodeSize, out);
    }
  } else {
    tr.replaceWith(from, to, build(schema, target, inlineBlocks(node)));
  }

  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from + 1, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function deleteBlock(view: EditorView, sel: NodeSelection): void {
  const tr = view.state.tr.deleteRange(sel.from, sel.to);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(sel.from, tr.doc.content.size))));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

let menu: HTMLElement | null = null;

function closeMenu(): void {
  menu?.remove();
  menu = null;
  document.removeEventListener('mousedown', onDismiss, true);
  document.removeEventListener('keydown', onKey, true);
}

function onDismiss(e: MouseEvent): void {
  if (menu && !menu.contains(e.target as Node)) closeMenu();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  }
}

function openMenu(view: EditorView, anchor: HTMLElement): void {
  closeMenu();
  const sel = view.state.selection;
  if (!(sel instanceof NodeSelection)) return;
  const current = currentTarget(sel.node);

  const el = document.createElement('div');
  el.className = 'mdw-block-menu';
  el.setAttribute('role', 'menu');
  const title = document.createElement('div');
  title.className = 'mdw-block-menu-title';
  title.textContent = 'Turn into';
  el.appendChild(title);
  for (const item of ITEMS) {
    const row = document.createElement('div');
    row.className = `mdw-block-menu-item${item.target === current ? ' active' : ''}`;
    row.setAttribute('role', 'menuitem');
    row.innerHTML = `<span class="mdw-block-menu-icon">${item.icon}</span><span>${item.label}</span>`;
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      closeMenu();
      if (item.target !== current) turnInto(view, sel, item.target);
      else view.focus();
    });
    el.appendChild(row);
  }
  const sep = document.createElement('div');
  sep.className = 'mdw-block-menu-sep';
  el.appendChild(sep);
  const del = document.createElement('div');
  del.className = 'mdw-block-menu-item mdw-block-menu-danger';
  del.setAttribute('role', 'menuitem');
  del.innerHTML = `<span class="mdw-block-menu-icon">✕</span><span>Delete</span>`;
  del.addEventListener('mousedown', (e) => {
    e.preventDefault();
    closeMenu();
    deleteBlock(view, sel);
  });
  el.appendChild(del);

  const rect = anchor.getBoundingClientRect();
  el.style.left = `${rect.right + 6}px`;
  el.style.top = `${rect.top}px`;
  document.body.appendChild(el);
  // Keep it on screen.
  const box = el.getBoundingClientRect();
  if (box.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, window.innerHeight - 8 - box.height)}px`;
  if (box.right > window.innerWidth - 8) el.style.left = `${Math.max(8, rect.left - box.width - 6)}px`;
  menu = el;
  setTimeout(() => {
    document.addEventListener('mousedown', onDismiss, true);
    document.addEventListener('keydown', onKey, true);
  });
}

/** Opens the block menu when the block handle's grip is clicked (pressed and released without dragging). */
export function installBlockMenu(getView: () => EditorView | null): void {
  // A plain `click` is unreliable here: the service's mousedown changes the
  // selection, the handle may re-position, and mouseup then lands on another
  // element, so the browser dispatches the click on a common ancestor.
  let pressed: { x: number; y: number } | null = null;
  document.addEventListener('mousedown', (e) => {
    const grip = (e.target as HTMLElement).closest?.(GRIP_SELECTOR);
    pressed = grip && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  });
  document.addEventListener('dragstart', () => (pressed = null), true);
  document.addEventListener('mouseup', (e) => {
    if (!pressed) return;
    const moved = Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 4;
    pressed = null;
    const grip = document.querySelector<HTMLElement>(GRIP_SELECTOR);
    const view = getView();
    if (moved || !grip || !view) return;
    e.preventDefault();
    openMenu(view, grip);
  });
  document.addEventListener('pointerover', (e) => {
    const grip = (e.target as HTMLElement).closest?.(GRIP_SELECTOR) as HTMLElement | null;
    if (grip && !grip.title) grip.title = 'Click for options, drag to move';
  });
}
