/**
 * Cmd/Ctrl+click opens links, like VS Code's text editor:
 * - anchors in the editor body;
 * - URL-looking tokens under the caret in frontmatter inputs/textareas.
 * While the modifier is held, body gets `mdw-mod` so links can show a hand cursor.
 */

const URL_RE = /(?:https?:\/\/|mailto:|www\.)[^\s<>"'`)\]]+/g;

function isModifier(e: MouseEvent | KeyboardEvent): boolean {
  return navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey;
}

/** The URL whose span in `text` contains `offset`, if any. */
function urlAt(text: string, offset: number): string | null {
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      return match[0].replace(/[.,;:!?]+$/, '');
    }
  }
  return null;
}

function offsetFromPoint(el: Element, x: number, y: number): { text: string; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const caret = doc.caretPositionFromPoint?.(x, y);
  const node = caret?.offsetNode;
  if (!node || !el.contains(node) || node.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  return { text: node.textContent ?? '', offset: caret.offset };
}

function urlFromFrontmatterTarget(target: Element, e: MouseEvent): string | null {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    // The mousedown already placed the caret.
    return urlAt(target.value, target.selectionStart ?? 0);
  }
  const hit = offsetFromPoint(target, e.clientX, e.clientY);
  return hit ? urlAt(hit.text, hit.offset) : null;
}

export function installLinkHandler(open: (href: string) => void): void {
  document.addEventListener(
    'click',
    (e) => {
      if (!isModifier(e) || e.button !== 0) {
        return;
      }
      const target = e.target as Element | null;
      if (!target) {
        return;
      }

      let href: string | null = null;
      const anchor = target.closest('a[href]');
      if (anchor && target.closest('.ProseMirror')) {
        href = anchor.getAttribute('href');
      } else if (target.closest('#frontmatter-host')) {
        href = urlFromFrontmatterTarget(target, e);
      }

      if (!href) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      open(href.startsWith('www.') ? `https://${href}` : href);
    },
    true
  );

  const setMod = (on: boolean) => document.body.classList.toggle('mdw-mod', on);
  window.addEventListener('keydown', (e) => isModifier(e) && setMod(true));
  window.addEventListener('keyup', (e) => !isModifier(e) && setMod(false));
  window.addEventListener('blur', () => setMod(false));
}
