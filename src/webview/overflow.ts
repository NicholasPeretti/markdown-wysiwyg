/**
 * Horizontal scrolling for wide tables that keeps header rows sticky.
 *
 * A real `overflow-x: auto` wrapper becomes the sticky containing block, so
 * `position: sticky` headers would stick to the wrapper, not the page. Instead,
 * wrappers wider than their container get `mdw-overflow` (CSS: `overflow-x:
 * clip`, which is *not* a scroll container) and are scrolled by translating
 * the table from wheel/trackpad events, with a slim custom scrollbar.
 */
const WRAPPERS = ['.milkdown-table-block .table-wrapper', '.mdw-qt-scroll'];
const SELECTOR = WRAPPERS.join(', ');
const TABLES = WRAPPERS.map((w) => `${w} > table`).join(', ');

interface ScrollState {
  x: number;
  bar: HTMLElement;
  thumb: HTMLElement;
  hideTimer?: number;
}

const states = new WeakMap<HTMLElement, ScrollState>();

export function installOverflowWatcher(root: HTMLElement): void {
  const seen = new WeakSet<Element>();
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) update(e.target as HTMLElement);
  });

  const scan = () => {
    root.querySelectorAll<HTMLElement>(TABLES).forEach(sizeTextColumns);
    root.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      ro.observe(el);
      const table = el.querySelector(':scope > table');
      if (table) ro.observe(table);
      update(el);
    });
  };

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  }).observe(root, { childList: true, subtree: true });
  scan();

  root.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('selectionchange', revealSelectedCell);
}

/** A clip container never scrolls on its own, so follow the caret into hidden cells. */
function revealSelectedCell(): void {
  const node = document.getSelection()?.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  const cell = el?.closest<HTMLElement>('td, th');
  const wrapper = cell?.closest<HTMLElement>(SELECTOR);
  if (!cell || !wrapper || !wrapper.classList.contains('mdw-overflow')) return;
  const state = states.get(wrapper);
  if (!state) return;
  const view = wrapper.getBoundingClientRect();
  const rect = cell.getBoundingClientRect();
  const pad = 16;
  if (rect.left < view.left) setScroll(wrapper, state, state.x - (view.left - rect.left) - pad);
  else if (rect.right > view.right) setScroll(wrapper, state, state.x + (rect.right - view.right) + pad);
}

const MAX_SIZED_COLUMNS = 24;

/**
 * Columns with a lot of prose get a minimum width so the browser's auto
 * layout can't squeeze them into a sliver next to columns with unbreakable
 * content; wide tables scroll anyway. Widths are set as CSS variables on the
 * wrapper (outside ProseMirror's editable DOM, which must not be touched).
 */
function sizeTextColumns(table: HTMLElement): void {
  const wrapper = table.parentElement;
  if (!wrapper) return;
  const longest: number[] = [];
  table.querySelectorAll<HTMLElement>(':scope > tbody > tr, :scope > thead > tr').forEach((row) => {
    Array.from(row.children).forEach((cell, i) => {
      const len = (cell.textContent ?? '').trim().length;
      longest[i] = Math.max(longest[i] ?? 0, len);
    });
  });
  for (let i = 0; i < MAX_SIZED_COLUMNS; i++) {
    const len = longest[i] ?? 0;
    const width = len >= 160 ? '24em' : len >= 60 ? '16em' : '';
    const prop = `--mdw-col-${i + 1}`;
    if (wrapper.style.getPropertyValue(prop) !== width) {
      if (width) wrapper.style.setProperty(prop, width);
      else wrapper.style.removeProperty(prop);
    }
  }
}

function tableOf(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(':scope > table');
}

function maxScroll(wrapper: HTMLElement): number {
  const table = tableOf(wrapper);
  if (!table) return 0;
  const available = wrapper.parentElement?.clientWidth ?? wrapper.clientWidth;
  return Math.max(0, table.offsetWidth - available);
}

function update(el: HTMLElement): void {
  const wrapper = el.closest<HTMLElement>(SELECTOR) ?? el;
  if (!tableOf(wrapper)) return;
  const max = maxScroll(wrapper);
  const overflowing = max > 1;
  wrapper.classList.toggle('mdw-overflow', overflowing);
  if (overflowing) {
    const state = ensureState(wrapper);
    setScroll(wrapper, state, Math.min(state.x, max));
  } else if (states.has(wrapper)) {
    setScroll(wrapper, states.get(wrapper)!, 0);
  }
}

function ensureState(wrapper: HTMLElement): ScrollState {
  let state = states.get(wrapper);
  if (state) return state;
  const bar = document.createElement('div');
  bar.className = 'mdw-hscroll';
  bar.contentEditable = 'false';
  const thumb = document.createElement('div');
  thumb.className = 'mdw-hscroll-thumb';
  bar.appendChild(thumb);
  wrapper.appendChild(bar);
  state = { x: 0, bar, thumb };
  states.set(wrapper, state);
  installThumbDrag(wrapper, state);
  return state;
}

function setScroll(wrapper: HTMLElement, state: ScrollState, x: number): void {
  const table = tableOf(wrapper);
  if (!table) return;
  const max = maxScroll(wrapper);
  state.x = Math.max(0, Math.min(max, x));
  table.style.transform = state.x ? `translateX(${-state.x}px)` : '';
  const available = wrapper.parentElement?.clientWidth ?? wrapper.clientWidth;
  const ratio = available / (available + max);
  state.thumb.style.width = `${Math.max(8, ratio * 100)}%`;
  state.thumb.style.left = `${(state.x / (available + max)) * 100}%`;
  state.bar.classList.toggle('mdw-hscroll-start', state.x <= 0);
  state.bar.classList.toggle('mdw-hscroll-end', state.x >= max - 0.5);
}

function flash(state: ScrollState): void {
  state.bar.classList.add('mdw-hscroll-active');
  window.clearTimeout(state.hideTimer);
  state.hideTimer = window.setTimeout(() => state.bar.classList.remove('mdw-hscroll-active'), 800);
}

function onWheel(e: WheelEvent): void {
  const wrapper = (e.target as HTMLElement).closest<HTMLElement>(SELECTOR);
  if (!wrapper || !wrapper.classList.contains('mdw-overflow')) return;
  const state = states.get(wrapper);
  if (!state) return;
  const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
  if (!dx) return;
  const max = maxScroll(wrapper);
  const next = Math.max(0, Math.min(max, state.x + dx));
  if (next === state.x) return;
  e.preventDefault();
  setScroll(wrapper, state, next);
  flash(state);
}

function installThumbDrag(wrapper: HTMLElement, state: ScrollState): void {
  state.thumb.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    down.stopPropagation();
    const startX = down.clientX;
    const startScroll = state.x;
    const available = wrapper.parentElement?.clientWidth ?? wrapper.clientWidth;
    const max = maxScroll(wrapper);
    const scale = (available + max) / state.bar.clientWidth;
    state.bar.classList.add('mdw-hscroll-dragging');
    const move = (ev: PointerEvent) => setScroll(wrapper, state, startScroll + (ev.clientX - startX) * scale);
    const up = () => {
      state.bar.classList.remove('mdw-hscroll-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
