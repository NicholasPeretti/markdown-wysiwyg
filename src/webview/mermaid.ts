/**
 * Mermaid diagrams: ```mermaid code blocks render their diagram in Crepe's
 * code block preview panel.
 *
 * Crepe hands us a fresh `apply` callback on every call, so there is no stable
 * per-block identity; results are cached by source text instead, which also
 * makes re-mounts (Crepe lazily mounts blocks as they scroll into view) free.
 */

import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import { addBlockTypeCommand, clearTextInCurrentBlockCommand, codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import type { Ctx } from '@milkdown/kit/ctx';
import type { SlashMenuBuilder } from './callouts';

type Apply = (el: HTMLElement | string | null) => void;

const CACHE_LIMIT = 50;
const cache = new Map<string, string>();
let seq = 0;
let configuredDark: boolean | undefined;

function isDark(): boolean {
  const c = document.body.classList;
  return c.contains('vscode-dark') || c.contains('vscode-high-contrast');
}

function cssVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

type Mermaid = typeof import('mermaid').default;
let loader: Promise<Mermaid> | undefined;

function load(): Promise<Mermaid> {
  return (loader ??= import('mermaid').then((m) => m.default));
}

function configure(mermaid: Mermaid): void {
  const dark = isDark();
  if (configuredDark === dark) return;
  configuredDark = dark;
  cache.clear();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: cssVar('--vscode-font-family') || 'inherit',
    themeVariables: {
      fontFamily: cssVar('--vscode-font-family') || 'inherit',
    },
  });
}

const EXPAND_BUTTON =
  '<button class="mdw-mermaid-expand" data-act="mermaid-expand" title="Open full screen" type="button">' +
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 2h5v1.5H3.5V7H2V2zm12 0v5h-1.5V3.5H9V2h5zM2 14V9h1.5v3.5H7V14H2zm12 0H9v-1.5h3.5V9H14v5z"/></svg>' +
  '</button>';

/** `renderPreview` for Crepe's code block config. */
export function renderMermaidPreview(language: string, content: string, apply: Apply): undefined | null {
  if (language.toLowerCase() !== 'mermaid') return null;
  const text = content.trim();
  if (!text) {
    apply('<div class="mdw-mermaid mdw-mermaid-empty">Empty diagram</div>');
    return undefined;
  }
  const hit = cache.get(text);
  if (hit) {
    apply(hit);
    return undefined;
  }
  void draw(text, apply);
  return undefined;
}

async function draw(text: string, apply: Apply): Promise<void> {
  const id = `mdw-mermaid-${++seq}`;
  try {
    const mermaid = await load();
    configure(mermaid);
    const { svg } = await mermaid.render(id, text);
    const html = `<div class="mdw-mermaid">${EXPAND_BUTTON}${svg}</div>`;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(text, html);
    apply(html);
  } catch (err) {
    // Mermaid leaves a detached error element behind on failure.
    document.getElementById('d' + id)?.remove();
    document.getElementById(id)?.remove();
    const msg = err instanceof Error ? err.message : String(err);
    const escaped = msg.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    apply(`<div class="mdw-mermaid-error">${escaped}</div>`);
  }
}

const SKELETON = 'graph TD\n  A[Start] --> B[End]';

/** Adds a "Diagram" entry to the slash menu that inserts a mermaid block. */
export function addMermaidSlashItem(builder: SlashMenuBuilder): void {
  builder.getGroup('advanced').addItem('mermaid', {
    label: 'Diagram',
    icon: '<span class="mdw-qt-slash-icon">◇</span>',
    onRun: (ctx: Ctx) => {
      const commands = ctx.get(commandsCtx);
      commands.call(clearTextInCurrentBlockCommand.key);
      commands.call(addBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx), attrs: { language: 'mermaid' } });
      const view = ctx.get(editorViewCtx);
      const { $from } = view.state.selection;
      if ($from.parent.type.name === 'code_block') {
        view.dispatch(view.state.tr.insertText(SKELETON, $from.pos));
      }
    },
  });
}

// ---- Full-screen viewer ----

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

interface Viewer {
  overlay: HTMLElement;
  stage: HTMLElement;
  label: HTMLElement;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
}

let viewer: Viewer | undefined;

/** Opens the full-screen viewer when a diagram's expand button is clicked. */
export function installMermaidViewer(): void {
  document.addEventListener(
    'click',
    (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act="mermaid-expand"]');
      if (!btn) return;
      const svg = btn.parentElement?.querySelector<SVGSVGElement>(':scope > svg');
      if (!svg) return;
      e.preventDefault();
      e.stopPropagation();
      openViewer(svg);
    },
    true
  );
}

function svgSize(svg: SVGSVGElement): { width: number; height: number } {
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
  const r = svg.getBoundingClientRect();
  return { width: r.width || 800, height: r.height || 600 };
}

function openViewer(source: SVGSVGElement): void {
  closeViewer();
  const { width, height } = svgSize(source);
  const svg = source.cloneNode(true) as SVGSVGElement;
  svg.removeAttribute('style');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  const overlay = document.createElement('div');
  overlay.className = 'mdw-mermaid-overlay';
  overlay.tabIndex = -1;
  const stage = document.createElement('div');
  stage.className = 'mdw-mermaid-stage';
  stage.appendChild(svg);
  const hud = document.createElement('div');
  hud.className = 'mdw-mermaid-hud';
  hud.innerHTML =
    '<button data-v="out" title="Zoom out (-)">−</button>' +
    '<span class="mdw-mermaid-zoom"></span>' +
    '<button data-v="in" title="Zoom in (+)">+</button>' +
    '<button data-v="fit" title="Fit (0)">Fit</button>' +
    '<button data-v="close" title="Close (Esc)">✕</button>';
  overlay.append(stage, hud);
  document.body.appendChild(overlay);

  const v: Viewer = { overlay, stage, label: hud.querySelector('.mdw-mermaid-zoom')!, width, height, x: 0, y: 0, scale: 1 };
  viewer = v;
  fit(v);

  hud.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-v]')?.dataset.v;
    if (act === 'in') zoomAt(v, 1.25, overlay.clientWidth / 2, overlay.clientHeight / 2);
    else if (act === 'out') zoomAt(v, 0.8, overlay.clientWidth / 2, overlay.clientHeight / 2);
    else if (act === 'fit') fit(v);
    else if (act === 'close') closeViewer();
  });

  overlay.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(v, Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      } else {
        v.x -= e.deltaX;
        v.y -= e.deltaY;
        applyTransform(v);
      }
    },
    { passive: false }
  );

  let drag: { x: number; y: number; px: number; py: number } | undefined;
  overlay.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.mdw-mermaid-hud')) return;
    drag = { x: v.x, y: v.y, px: e.clientX, py: e.clientY };
    overlay.setPointerCapture(e.pointerId);
    overlay.classList.add('dragging');
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    v.x = drag.x + (e.clientX - drag.px);
    v.y = drag.y + (e.clientY - drag.py);
    applyTransform(v);
  });
  const endDrag = () => {
    drag = undefined;
    overlay.classList.remove('dragging');
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);
  overlay.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.mdw-mermaid-hud')) return;
    zoomAt(v, 1.5, e.clientX, e.clientY);
  });

  overlay.addEventListener('keydown', (e) => {
    const cx = overlay.clientWidth / 2;
    const cy = overlay.clientHeight / 2;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === '+' || e.key === '=') zoomAt(v, 1.25, cx, cy);
    else if (e.key === '-') zoomAt(v, 0.8, cx, cy);
    else if (e.key === '0') fit(v);
    else if (e.key.startsWith('Arrow')) {
      const step = 40;
      if (e.key === 'ArrowLeft') v.x += step;
      if (e.key === 'ArrowRight') v.x -= step;
      if (e.key === 'ArrowUp') v.y += step;
      if (e.key === 'ArrowDown') v.y -= step;
      applyTransform(v);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  overlay.focus();
}

function closeViewer(): void {
  viewer?.overlay.remove();
  viewer = undefined;
}

function fit(v: Viewer): void {
  const pad = 48;
  const w = v.overlay.clientWidth - pad * 2;
  const h = v.overlay.clientHeight - pad * 2;
  v.scale = Math.min(w / v.width, h / v.height, 2);
  v.x = (v.overlay.clientWidth - v.width * v.scale) / 2;
  v.y = (v.overlay.clientHeight - v.height * v.scale) / 2;
  applyTransform(v);
}

function zoomAt(v: Viewer, factor: number, cx: number, cy: number): void {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
  const k = next / v.scale;
  v.x = cx - (cx - v.x) * k;
  v.y = cy - (cy - v.y) * k;
  v.scale = next;
  applyTransform(v);
}

function applyTransform(v: Viewer): void {
  v.stage.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  v.label.textContent = `${Math.round(v.scale * 100)}%`;
}
