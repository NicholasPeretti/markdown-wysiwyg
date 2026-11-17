/**
 * Marks table wrappers that are wider than their container with
 * `mdw-overflow`, so CSS can turn them into horizontal scroll containers
 * only when needed (a scroll container would break the sticky header).
 */
const SELECTOR = '.milkdown-table-block .table-wrapper, .mdw-qt-scroll';

export function installOverflowWatcher(root: HTMLElement): void {
  const seen = new WeakSet<Element>();
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) update(e.target as HTMLElement);
  });

  const scan = () => {
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
}

function update(el: HTMLElement): void {
  const wrapper = el.closest<HTMLElement>(SELECTOR) ?? el;
  const table = wrapper.querySelector<HTMLElement>(':scope > table');
  if (!table) return;
  // Compare the table's natural width against the wrapper's available width;
  // scrollWidth is unreliable once overflow-x: auto is applied.
  const available = wrapper.parentElement?.clientWidth ?? wrapper.clientWidth;
  wrapper.classList.toggle('mdw-overflow', table.offsetWidth > available + 1);
}
