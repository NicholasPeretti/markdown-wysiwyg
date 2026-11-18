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

const EXPAND_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 2h5v1.5H3.5V7H2V2zm12 0v5h-1.5V3.5H9V2h5zM2 14V9h1.5v3.5H7V14H2zm12 0H9v-1.5h3.5V9H14v5z"/></svg>';

const HUD_HTML = (full: boolean) =>
  '<button data-v="out" title="Zoom out" type="button">−</button>' +
  '<span class="mdw-mermaid-zoom">100%</span>' +
  '<button data-v="in" title="Zoom in" type="button">+</button>' +
  (full
    ? '<button data-v="fit" title="Fit (0)" type="button">Fit</button>' +
      '<button data-v="close" title="Close (Esc)" type="button">✕</button>'
    : '<button data-v="reset" title="Reset zoom" type="button">Reset</button>' +
      `<button data-v="expand" title="Open full screen" type="button">${EXPAND_ICON}</button>`);

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
    const html = `<div class="mdw-mermaid"><div class="mdw-mermaid-stage">${svg}</div><div class="mdw-mermaid-hud">${HUD_HTML(false)}</div></div>`;
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

// ---- Pan & zoom (inline preview and full-screen viewer) ----

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

interface PanZoom {
  container: HTMLElement;
  stage: HTMLElement;
  x: number;
  y: number;
  scale: number;
}

const inline = new WeakMap<HTMLElement, PanZoom>();
let overlay: PanZoom | undefined;

function panZoomFor(target: EventTarget | null): PanZoom | undefined {
  const el = (target as HTMLElement | null)?.closest<HTMLElement>('.mdw-mermaid, .mdw-mermaid-overlay');
  if (!el) return undefined;
  if (el === overlay?.container) return overlay;
  let pz = inline.get(el);
  if (!pz) {
    const stage = el.querySelector<HTMLElement>(':scope > .mdw-mermaid-stage');
    if (!stage) return undefined;
    pz = { container: el, stage, x: 0, y: 0, scale: 1 };
    inline.set(el, pz);
  }
  return pz;
}

/** Wires zoom/pan for inline diagrams and the full-screen viewer (event delegation:
 *  the preview DOM is recreated by Crepe on every edit). */
export function installMermaidViewer(): void {
  document.addEventListener(
    'click',
    (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.mdw-mermaid-hud [data-v]');
      if (!btn) return;
      const pz = panZoomFor(btn);
      if (!pz) return;
      e.preventDefault();
      e.stopPropagation();
      const { clientWidth: w, clientHeight: h } = pz.container;
      const rect = pz.container.getBoundingClientRect();
      switch (btn.dataset.v) {
        case 'in':
          zoomAt(pz, 1.25, rect.left + w / 2, rect.top + h / 2);
          break;
        case 'out':
          zoomAt(pz, 0.8, rect.left + w / 2, rect.top + h / 2);
          break;
        case 'reset':
          reset(pz);
          break;
        case 'fit':
          fit(pz);
          break;
        case 'expand': {
          const svg = pz.stage.querySelector<SVGSVGElement>(':scope > svg');
          if (svg) openViewer(svg);
          break;
        }
        case 'close':
          closeViewer();
          break;
      }
    },
    true
  );

  document.addEventListener(
    'wheel',
    (e) => {
      const pz = panZoomFor(e.target);
      if (!pz) return;
      const full = pz === overlay;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(pz, Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      } else if (full || pz.scale !== 1) {
        e.preventDefault();
        pz.x -= e.deltaX;
        pz.y -= e.deltaY;
        applyTransform(pz);
      }
    },
    { passive: false, capture: true }
  );

  let drag: { pz: PanZoom; x: number; y: number; px: number; py: number } | undefined;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.mdw-mermaid-hud')) return;
      const pz = panZoomFor(e.target);
      if (!pz || (pz !== overlay && pz.scale === 1)) return;
      e.preventDefault();
      drag = { pz, x: pz.x, y: pz.y, px: e.clientX, py: e.clientY };
      pz.container.setPointerCapture(e.pointerId);
      pz.container.classList.add('dragging');
    },
    true
  );
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.pz.x = drag.x + (e.clientX - drag.px);
    drag.pz.y = drag.y + (e.clientY - drag.py);
    applyTransform(drag.pz);
  });
  const endDrag = () => {
    drag?.pz.container.classList.remove('dragging');
    drag = undefined;
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
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

  const container = document.createElement('div');
  container.className = 'mdw-mermaid-overlay';
  container.tabIndex = -1;
  const stage = document.createElement('div');
  stage.className = 'mdw-mermaid-stage';
  stage.appendChild(svg);
  const hud = document.createElement('div');
  hud.className = 'mdw-mermaid-hud';
  hud.innerHTML = HUD_HTML(true);
  container.append(stage, hud);
  document.body.appendChild(container);

  const pz: PanZoom = { container, stage, x: 0, y: 0, scale: 1 };
  overlay = pz;
  fit(pz);

  container.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.mdw-mermaid-hud')) return;
    zoomAt(pz, 1.5, e.clientX, e.clientY);
  });
  container.addEventListener('keydown', (e) => {
    const rect = container.getBoundingClientRect();
    const cx = rect.left + container.clientWidth / 2;
    const cy = rect.top + container.clientHeight / 2;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === '+' || e.key === '=') zoomAt(pz, 1.25, cx, cy);
    else if (e.key === '-') zoomAt(pz, 0.8, cx, cy);
    else if (e.key === '0') fit(pz);
    else if (e.key.startsWith('Arrow')) {
      const step = 40;
      if (e.key === 'ArrowLeft') pz.x += step;
      if (e.key === 'ArrowRight') pz.x -= step;
      if (e.key === 'ArrowUp') pz.y += step;
      if (e.key === 'ArrowDown') pz.y -= step;
      applyTransform(pz);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  container.focus();
}

function closeViewer(): void {
  overlay?.container.remove();
  overlay = undefined;
}

function fit(pz: PanZoom): void {
  const svg = pz.stage.querySelector<SVGSVGElement>(':scope > svg');
  if (!svg) return;
  const { width, height } = svgSize(svg);
  const pad = 48;
  const w = pz.container.clientWidth - pad * 2;
  const h = pz.container.clientHeight - pad * 2;
  pz.scale = Math.min(w / width, h / height, 2);
  pz.x = (pz.container.clientWidth - width * pz.scale) / 2;
  pz.y = (pz.container.clientHeight - height * pz.scale) / 2;
  applyTransform(pz);
}

function reset(pz: PanZoom): void {
  pz.x = 0;
  pz.y = 0;
  pz.scale = 1;
  applyTransform(pz);
}

/** Zooms keeping the point under (cx, cy) (client coords) fixed. */
function zoomAt(pz: PanZoom, factor: number, cx: number, cy: number): void {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pz.scale * factor));
  const k = next / pz.scale;
  const rect = pz.container.getBoundingClientRect();
  // The stage's untransformed layout offset (flex-centred inline, 0 in the overlay).
  const ox = rect.left + pz.stage.offsetLeft;
  const oy = rect.top + pz.stage.offsetTop;
  pz.x = cx - ox - (cx - ox - pz.x) * k;
  pz.y = cy - oy - (cy - oy - pz.y) * k;
  pz.scale = next;
  applyTransform(pz);
}

function applyTransform(pz: PanZoom): void {
  const identity = pz !== overlay && pz.scale === 1 && pz.x === 0 && pz.y === 0;
  pz.stage.style.transform = identity ? '' : `translate(${pz.x}px, ${pz.y}px) scale(${pz.scale})`;
  pz.container.classList.toggle('zoomed', !identity);
  const label = pz.container.querySelector<HTMLElement>(':scope > .mdw-mermaid-hud .mdw-mermaid-zoom');
  if (label) label.textContent = `${Math.round(pz.scale * 100)}%`;
}
