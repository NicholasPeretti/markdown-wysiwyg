/**
 * Keyboard helpers shared by the webview's ad-hoc inputs (find bar, table
 * cell editors, relation picker).
 *
 * VS Code learns about keybindings pressed inside a webview by listening for
 * the *trusted* keydown on the iframe's window, so anything that stops
 * propagation of a chord such as ⌃` or ⌘⌃F silently disables that shortcut.
 * Inputs that live inside the ProseMirror/CodeMirror DOM still need to keep
 * ordinary typing away from the editors, so we only isolate events that no
 * workbench keybinding could be interested in.
 */

const IS_MAC = navigator.platform.toLowerCase().includes('mac');

/** True when exactly the platform's primary modifier (⌘ on Mac, Ctrl elsewhere) is held. */
export function isPrimaryMod(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** True for chords that VS Code may own and must see bubble to `window`. */
export function isShortcutChord(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || (e.altKey && e.key.length > 1);
}

const ISOLATED = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy', 'mousedown', 'click', 'dblclick'];

/**
 * Keeps events meant for `el` from reaching the surrounding editors, while
 * letting modifier chords through so VS Code's keybindings keep working.
 */
export function isolateInput(el: HTMLElement): void {
  for (const type of ISOLATED) {
    el.addEventListener(type, (ev) => {
      if (ev instanceof KeyboardEvent && isShortcutChord(ev)) return;
      ev.stopPropagation();
    });
  }
}
