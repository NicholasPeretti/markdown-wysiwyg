/**
 * Keeps the page from jumping while reading.
 *
 * Milkdown tears code blocks down to a bare `<pre>` placeholder once they are
 * off-screen and rebuilds them when they come back. Diagrams and query tables
 * are far taller than their source text, so the swap changes the height of
 * content above the viewport and the page lurches. We remember each block's
 * rendered height and pin its placeholder to it.
 */

const BLOCK = ".milkdown-code-block";
const PLACEHOLDER = ".milkdown-code-block-placeholder";

const heights = new WeakMap<Element, number>();

const sizes = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (!(target instanceof HTMLElement) || target.querySelector(PLACEHOLDER))
      continue;
    target.style.minHeight = "";
    const h = target.getBoundingClientRect().height;
    if (h > 0) heights.set(target, h);
  }
});

function pin(placeholder: HTMLElement): void {
  const block = placeholder.closest<HTMLElement>(BLOCK);
  const h = block && heights.get(block);
  if (block && h) block.style.minHeight = `${h}px`;
}

function watch(block: Element): void {
  sizes.observe(block);
  const ph = block.querySelector<HTMLElement>(PLACEHOLDER);
  if (ph) pin(ph);
}

export function installStableBlocks(root: HTMLElement): void {
  root.querySelectorAll(BLOCK).forEach(watch);
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (n.matches(PLACEHOLDER)) pin(n);
        else if (n.matches(BLOCK)) watch(n);
        else n.querySelectorAll(BLOCK).forEach(watch);
      });
    }
  }).observe(root, { childList: true, subtree: true });
}
