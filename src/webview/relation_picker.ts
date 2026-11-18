/**
 * Popover for picking relation values (Notion-style): the target folder's
 * files as options with check marks, a "Create" row for new options and,
 * unless an external input drives it, a filter box with the current values
 * as pills. Shared by query table cells and the properties panel.
 */

export interface PickerOption {
  value: string;
  label: string;
  path: string;
}

export interface PickerConfig {
  anchor: HTMLElement;
  options: PickerOption[];
  selected: string[];
  multi: boolean;
  /**
   * Existing text input that filters the list (chips-with-autocomplete mode).
   * Without it the popover renders its own filter box and pills.
   */
  input?: HTMLInputElement;
  /** Called once when the popover closes, with the final values and the names of new options. */
  onClose(values: string[], created: string[], changed: boolean): void;
}

export interface Picker {
  close(): void;
}

let current: Picker | undefined;

export function closeRelationPicker(): void {
  current?.close();
}

export function openRelationPicker(cfg: PickerConfig): Picker {
  current?.close();

  const values = [...cfg.selected];
  const created: string[] = [];
  const initial = JSON.stringify(values);
  const external = !!cfg.input;
  let highlight = 0;
  let closed = false;

  const pop = document.createElement('div');
  pop.className = 'mdw-rel-picker';
  pop.setAttribute('role', 'listbox');
  pop.innerHTML = external
    ? '<div class="mdw-rel-list"></div>'
    : `<div class="mdw-rel-head">
      <span class="mdw-rel-selected"></span>
      <input class="mdw-rel-filter" type="text" placeholder="Search or create…" spellcheck="false" />
    </div>
    <div class="mdw-rel-list"></div>`;
  document.body.appendChild(pop);
  const selectedEl = pop.querySelector<HTMLElement>('.mdw-rel-selected');
  const filter = cfg.input ?? pop.querySelector<HTMLInputElement>('.mdw-rel-filter')!;
  const list = pop.querySelector<HTMLElement>('.mdw-rel-list')!;

  const position = () => {
    const r = cfg.anchor.getBoundingClientRect();
    const width = Math.max(240, Math.min(360, r.width));
    let left = Math.min(r.left, window.innerWidth - width - 8);
    left = Math.max(8, left);
    pop.style.width = `${width}px`;
    pop.style.left = `${left}px`;
    const below = window.innerHeight - r.bottom;
    const height = pop.offsetHeight || 280;
    if (below < height + 8 && r.top > height + 8) {
      pop.style.top = `${r.top - height - 4}px`;
    } else {
      pop.style.top = `${r.bottom + 4}px`;
    }
  };

  const labelOf = (v: string) => cfg.options.find((o) => o.value === v)?.label ?? v;

  type Row = { kind: 'option'; option: PickerOption } | { kind: 'create'; name: string };
  let rows: Row[] = [];

  const render = () => {
    if (selectedEl) {
      selectedEl.innerHTML = values
        .map(
          (v) =>
            `<span class="mdw-rel-pill" data-value="${escapeAttr(v)}">${escapeHtml(labelOf(v))}<button class="mdw-rel-pill-x" tabindex="-1" aria-label="Remove">✕</button></span>`
        )
        .join('');
    }
    const q = filter.value.trim().toLowerCase();
    const matching = cfg.options.filter(
      (o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    );
    rows = matching.map((option) => ({ kind: 'option', option }));
    const exact = cfg.options.some((o) => o.value.toLowerCase() === q || o.label.toLowerCase() === q);
    if (q && !exact) {
      rows.push({ kind: 'create', name: filter.value.trim() });
    }
    highlight = Math.max(0, Math.min(highlight, rows.length - 1));
    list.innerHTML = rows.length
      ? rows
          .map((row, i) => {
            const hl = i === highlight ? ' mdw-rel-hl' : '';
            if (row.kind === 'create') {
              return `<div class="mdw-rel-item mdw-rel-create${hl}" data-i="${i}" role="option">Create <b>${escapeHtml(row.name)}</b></div>`;
            }
            const on = values.includes(row.option.value);
            return `<div class="mdw-rel-item${hl}${on ? ' mdw-rel-on' : ''}" data-i="${i}" role="option" aria-selected="${on}">
              <span class="mdw-rel-check" aria-hidden="true">${on ? '✓' : ''}</span>
              <span class="mdw-rel-label">${escapeHtml(row.option.label)}</span>
              ${row.option.label !== row.option.value ? `<span class="mdw-rel-value">${escapeHtml(row.option.value)}</span>` : ''}
            </div>`;
          })
          .join('')
      : '<div class="mdw-rel-empty">No options</div>';
    list.querySelector('.mdw-rel-hl')?.scrollIntoView({ block: 'nearest' });
    position();
  };

  const toggle = (value: string) => {
    const i = values.indexOf(value);
    if (!cfg.multi) {
      values.splice(0, values.length, ...(i >= 0 ? [] : [value]));
      close();
      return;
    }
    if (i >= 0) values.splice(i, 1);
    else values.push(value);
    filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: false }));
    render();
  };

  const pick = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'create') {
      created.push(row.name);
      cfg.options.push({ value: row.name, label: row.name, path: '' });
      toggle(row.name);
    } else {
      toggle(row.option.value);
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    pop.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
    if (external) {
      filter.removeEventListener('input', onInput);
      filter.removeEventListener('keydown', onKey);
      filter.removeEventListener('blur', onBlur);
    }
    if (current === picker) current = undefined;
    cfg.onClose(values, created, JSON.stringify(values) !== initial);
  };

  const onDocDown = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!pop.contains(t) && !(external && cfg.anchor.contains(t))) close();
  };
  const onBlur = () => {
    // Let a click inside the popover land first.
    setTimeout(() => {
      if (!closed && document.activeElement !== filter) close();
    }, 0);
  };
  const onInput = () => {
    highlight = 0;
    render();
  };
  const onKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        highlight = Math.min(rows.length - 1, highlight + 1);
        render();
        break;
      case 'ArrowUp':
        e.preventDefault();
        highlight = Math.max(0, highlight - 1);
        render();
        break;
      case 'Enter':
        e.preventDefault();
        pick(rows[highlight]);
        break;
      case 'Backspace':
        if (filter.value === '' && values.length && cfg.multi) {
          e.preventDefault();
          values.pop();
          render();
        }
        break;
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        close();
        break;
    }
  };

  for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy', 'mousedown', 'click', 'dblclick']) {
    pop.addEventListener(type, (ev) => ev.stopPropagation());
  }
  filter.addEventListener('input', onInput);
  filter.addEventListener('keydown', onKey);
  if (external) filter.addEventListener('blur', onBlur);
  pop.addEventListener('mousedown', (e) => {
    // Keep focus in the filter when clicking rows/pills.
    if (e.target !== filter) e.preventDefault();
  });
  pop.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const x = target.closest<HTMLElement>('.mdw-rel-pill-x');
    if (x) {
      const v = x.parentElement!.dataset.value!;
      values.splice(values.indexOf(v), 1);
      render();
      return;
    }
    const item = target.closest<HTMLElement>('.mdw-rel-item');
    if (item) pick(rows[Number(item.dataset.i)]);
  });

  document.addEventListener('mousedown', onDocDown, true);
  window.addEventListener('scroll', position, true);
  window.addEventListener('resize', position);

  const picker: Picker = { close };
  current = picker;
  render();
  filter.focus();
  return picker;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
