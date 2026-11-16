/**
 * Obsidian-style frontmatter "properties" panel.
 *
 * YAML frontmatter is parsed into typed key/value rows (text, number,
 * checkbox, list pills). Complex values stay read-only. A toggle switches to
 * raw YAML editing, which is also the automatic fallback when the YAML cannot
 * be represented as a flat map. `null` means the document has no frontmatter.
 */
import YAML from 'yaml';

export interface FrontmatterPanel {
  get(): string | null;
  set(value: string | null): void;
}

type Entry = [key: string, value: unknown];

function parseEntries(raw: string): Entry[] | null {
  if (raw.trim() === '') {
    return [];
  }
  try {
    const doc = YAML.parse(raw);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return null;
    }
    return Object.entries(doc);
  } catch {
    return null;
  }
}

function stringifyEntries(entries: Entry[]): string {
  if (entries.length === 0) {
    return '';
  }
  return YAML.stringify(Object.fromEntries(entries)).trimEnd();
}

function typeIcon(value: unknown): string {
  if (typeof value === 'boolean') return '☑';
  if (typeof value === 'number') return '#';
  if (Array.isArray(value)) return '≔';
  if (value !== null && typeof value === 'object') return '{}';
  return 'Aa';
}

function coerceScalar(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return text;
}

export function createFrontmatterPanel(
  container: HTMLElement,
  onChange: () => void
): FrontmatterPanel {
  /** Raw YAML (without ---) as written to the file; null = no frontmatter. */
  let raw: string | null = null;
  let entries: Entry[] | null = null;
  let rawMode = false;

  const addButton = document.createElement('button');
  addButton.className = 'mdw-fm-add';
  addButton.textContent = '+ Add frontmatter';

  const wrap = document.createElement('div');
  wrap.className = 'mdw-frontmatter';

  const header = document.createElement('div');
  header.className = 'mdw-fm-header';
  const label = document.createElement('span');
  label.textContent = 'Properties';
  const headerButtons = document.createElement('span');
  const modeButton = document.createElement('button');
  modeButton.className = 'mdw-fm-btn';
  modeButton.title = 'Toggle raw YAML';
  const removeButton = document.createElement('button');
  removeButton.className = 'mdw-fm-btn mdw-fm-remove';
  removeButton.title = 'Remove frontmatter';
  removeButton.textContent = '✕';
  headerButtons.append(modeButton, removeButton);
  header.append(label, headerButtons);

  const body = document.createElement('div');
  body.className = 'mdw-fm-body';

  wrap.append(header, body);
  container.append(addButton, wrap);

  const commit = (nextEntries: Entry[]) => {
    entries = nextEntries;
    raw = stringifyEntries(nextEntries);
    onChange();
  };

  const render = () => {
    const present = raw !== null;
    wrap.style.display = present ? 'block' : 'none';
    addButton.style.display = present ? 'none' : 'inline-block';
    if (!present) {
      return;
    }
    entries = parseEntries(raw as string);
    const structured = entries !== null && !rawMode;
    modeButton.textContent = structured ? '{ }' : '⊞';
    modeButton.style.display = entries === null ? 'none' : 'inline-block';
    body.replaceChildren(structured ? renderRows(entries as Entry[]) : renderRaw());
  };

  const renderRaw = (): HTMLElement => {
    const textarea = document.createElement('textarea');
    textarea.className = 'mdw-fm-textarea';
    textarea.spellcheck = false;
    textarea.value = raw ?? '';
    const autoresize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    textarea.addEventListener('input', () => {
      raw = textarea.value;
      autoresize();
      onChange();
    });
    requestAnimationFrame(autoresize);
    return textarea;
  };

  const renderRows = (current: Entry[]): HTMLElement => {
    const rows = document.createElement('div');
    rows.className = 'mdw-fm-rows';

    current.forEach((entry, index) => {
      rows.appendChild(renderRow(current, entry, index));
    });

    const addProp = document.createElement('button');
    addProp.className = 'mdw-fm-add-prop';
    addProp.textContent = '+ Add property';
    addProp.addEventListener('click', () => {
      commit([...current, ['', '']]);
      render();
      rows.parentElement
        ?.querySelectorAll<HTMLInputElement>('.mdw-fm-key')
        .item(current.length)
        ?.focus();
    });
    rows.appendChild(addProp);
    return rows;
  };

  const renderRow = (current: Entry[], [key, value]: Entry, index: number): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'mdw-fm-row';

    const icon = document.createElement('span');
    icon.className = 'mdw-fm-icon';
    icon.textContent = typeIcon(value);

    const keyInput = document.createElement('input');
    keyInput.className = 'mdw-fm-key';
    keyInput.value = key;
    keyInput.spellcheck = false;
    keyInput.placeholder = 'name';
    keyInput.addEventListener('change', () => {
      const next = [...current] as Entry[];
      next[index] = [keyInput.value.trim(), value];
      commit(next.filter(([k]) => k !== ''));
      render();
    });

    const del = document.createElement('button');
    del.className = 'mdw-fm-btn mdw-fm-row-del';
    del.title = 'Remove property';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      commit(current.filter((_, i) => i !== index));
      render();
    });

    row.append(icon, keyInput, renderValue(current, value, index), del);
    return row;
  };

  const renderValue = (current: Entry[], value: unknown, index: number): HTMLElement => {
    const setValue = (next: unknown) => {
      const nextEntries = [...current] as Entry[];
      nextEntries[index] = [nextEntries[index][0], next];
      commit(nextEntries);
    };

    if (typeof value === 'boolean') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'mdw-fm-check';
      checkbox.checked = value;
      checkbox.addEventListener('change', () => setValue(checkbox.checked));
      const host = document.createElement('div');
      host.className = 'mdw-fm-value';
      host.appendChild(checkbox);
      return host;
    }

    if (Array.isArray(value)) {
      return renderPills(value, setValue);
    }

    if (value !== null && typeof value === 'object') {
      const host = document.createElement('div');
      host.className = 'mdw-fm-value mdw-fm-complex';
      host.textContent = YAML.stringify(value).trimEnd();
      host.title = 'Nested value — edit in raw YAML mode';
      return host;
    }

    const input = document.createElement('input');
    input.className = 'mdw-fm-value mdw-fm-text';
    input.spellcheck = false;
    input.placeholder = 'empty';
    input.value = value === null || value === undefined ? '' : String(value);
    input.addEventListener('change', () => {
      setValue(typeof value === 'number' ? coerceScalar(input.value) : input.value);
      render();
    });
    return input;
  };

  const renderPills = (
    values: unknown[],
    setValue: (next: unknown) => void
  ): HTMLElement => {
    const host = document.createElement('div');
    host.className = 'mdw-fm-value mdw-fm-pills';

    values.forEach((v, i) => {
      const pill = document.createElement('span');
      pill.className = 'mdw-fm-pill';
      const text = document.createElement('span');
      text.textContent = String(v);
      const x = document.createElement('button');
      x.className = 'mdw-fm-pill-x';
      x.textContent = '✕';
      x.addEventListener('click', () => {
        setValue(values.filter((_, j) => j !== i));
        render();
      });
      pill.append(text, x);
      host.appendChild(pill);
    });

    const input = document.createElement('input');
    input.className = 'mdw-fm-pill-input';
    input.placeholder = '+';
    input.spellcheck = false;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim() !== '') {
        setValue([...values, coerceScalar(input.value)]);
        render();
      } else if (e.key === 'Backspace' && input.value === '' && values.length > 0) {
        setValue(values.slice(0, -1));
        render();
      }
    });
    host.appendChild(input);
    return host;
  };

  modeButton.addEventListener('click', () => {
    rawMode = !rawMode;
    render();
  });

  addButton.addEventListener('click', () => {
    raw = '';
    rawMode = false;
    render();
  });

  removeButton.addEventListener('click', () => {
    raw = null;
    render();
    onChange();
  });

  render();

  return {
    get: () => raw,
    set: (next) => {
      if (next !== raw) {
        raw = next;
        render();
      }
    },
  };
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Splits leading YAML frontmatter from a markdown document. */
export function splitFrontmatter(text: string): { fm: string | null; body: string } {
  const match = FM_RE.exec(text);
  if (!match) {
    return { fm: null, body: text };
  }
  return { fm: match[1], body: text.slice(match[0].length).replace(/^\r?\n/, '') };
}

/** Recombines frontmatter and body into a full document. */
export function composeDocument(fm: string | null, body: string): string {
  if (fm === null) {
    return body;
  }
  return `---\n${fm}\n---\n\n${body}`;
}
