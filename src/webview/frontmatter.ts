/**
 * Obsidian-style frontmatter "properties" panel.
 *
 * YAML frontmatter is parsed into typed key/value rows (text, number,
 * checkbox, list pills). Complex values stay read-only. A toggle switches to
 * raw YAML editing, which is also the automatic fallback when the YAML cannot
 * be represented as a flat map. `null` means the document has no frontmatter.
 */
import YAML from 'yaml';
import { isUrl } from './links';
import { parseRelations, type Relation } from '../query/relations';
import { openRelationPicker, type PickerOption } from './relation_picker';
import { onRelationOptionsChanged, peekOptions } from './relation_options';

export interface PanelHooks {
  /** Open another markdown file (relative to the index root). */
  openFile?(path: string): void;
  /** Create a new option file for a relation. */
  createOption?(relation: Relation, name: string): void;
}

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
  onChange: () => void,
  hooks: PanelHooks = {}
): FrontmatterPanel {
  /** Raw YAML (without ---) as written to the file; null = no frontmatter. */
  let raw: string | null = null;
  let entries: Entry[] | null = null;
  let rawMode = false;
  /** Relations declared in this document's own `relations:` field. */
  let relations = new Map<string, Relation>();
  /** Field currently being edited, so option refreshes don't yank the input. */
  let editingField: string | undefined;

  onRelationOptionsChanged(() => {
    if (editingField === undefined && raw !== null && !rawMode) render();
  });

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
    relations = parseRelations(Object.fromEntries(entries ?? []).relations, '');
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
    // Declared relation fields the file has no value for yet.
    for (const field of relations.keys()) {
      if (!current.some(([k]) => k === field)) {
        rows.appendChild(renderRow(current, [field, null], -1));
      }
    }

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

    const relation = relations.get(key);
    if (relation) icon.textContent = relation.multi ? '⊞' : '▾';
    if (index < 0) {
      // Implicit row from `relations:`; it gets a real entry once a value is set.
      keyInput.disabled = true;
      del.style.visibility = 'hidden';
    }
    row.append(icon, keyInput, renderValue(current, value, index, relation), del);
    return row;
  };

  const renderValue = (
    current: Entry[],
    value: unknown,
    index: number,
    relation?: Relation
  ): HTMLElement => {
    const setValue = (next: unknown) => {
      const nextEntries = [...current] as Entry[];
      nextEntries[index] = [nextEntries[index][0], next];
      commit(nextEntries);
    };

    if (relation) {
      const key = index < 0 ? undefined : current[index][0];
      const setRelValue = (next: unknown) => {
        if (key !== undefined) return setValue(next);
        const field = [...relations.keys()].find((f) => !current.some(([k]) => k === f) && relations.get(f) === relation)!;
        commit([...current, [field, next]]);
      };
      return relation.multi ? renderRelationChips(value, relation, setRelValue) : renderRelationSelect(value, relation, setRelValue);
    }

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

    if (index >= 0 && current[index][0] === 'relations' && value !== null && typeof value === 'object') {
      const host = document.createElement('div');
      host.className = 'mdw-fm-value mdw-fm-complex mdw-fm-schema';
      host.textContent = [...relations.entries()]
        .map(([f, r]) => `${f} → ${r.folder || '.'}${r.field ? `.${r.field}` : ''}${r.multi ? ' (multi)' : ''}`)
        .join(', ');
      host.title = `${YAML.stringify(value).trimEnd()}\n\nEdit in raw YAML mode`;
      return host;
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
    const markLink = () => input.classList.toggle('mdw-fm-link', isUrl(input.value));
    markLink();
    input.addEventListener('input', markLink);
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
      text.classList.toggle('mdw-fm-link', isUrl(String(v)));
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

  const relationValues = (value: unknown): string[] =>
    (Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]).map(String);

  const renderRelationChips = (
    value: unknown,
    relation: Relation,
    setValue: (next: unknown) => void
  ): HTMLElement => {
    const values = relationValues(value);
    const options = peekOptions(relation) ?? [];
    const host = document.createElement('div');
    host.className = 'mdw-fm-value mdw-fm-pills mdw-fm-relation';

    values.forEach((v, i) => {
      const option = options.find((o) => o.value === v);
      host.appendChild(
        relationPill(v, option, () => {
          setValue(values.filter((_, j) => j !== i));
          render();
        })
      );
    });

    const input = document.createElement('input');
    input.className = 'mdw-fm-pill-input';
    input.placeholder = '+';
    input.spellcheck = false;
    const open = () => {
      if (editingField !== undefined) return;
      editingField = relation.folder;
      openRelationPicker({
        anchor: host,
        input,
        options: [...(peekOptions(relation) ?? [])],
        selected: values,
        multi: true,
        onClose: (next, created, changed) => {
          editingField = undefined;
          if (!changed) return;
          for (const name of created) hooks.createOption?.(relation, name);
          setValue(next);
          render();
        },
      });
    };
    input.addEventListener('focus', open);
    input.addEventListener('mousedown', () => input.focus());
    host.appendChild(input);
    return host;
  };

  const renderRelationSelect = (
    value: unknown,
    relation: Relation,
    setValue: (next: unknown) => void
  ): HTMLElement => {
    const current = relationValues(value)[0];
    const options = peekOptions(relation) ?? [];
    const host = document.createElement('div');
    host.className = 'mdw-fm-value mdw-fm-relation mdw-fm-select-host';

    const select = document.createElement('select');
    select.className = 'mdw-fm-select';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '—';
    select.appendChild(empty);
    if (current !== undefined && !options.some((o) => o.value === current)) {
      const missing = document.createElement('option');
      missing.value = current;
      missing.textContent = `${current} (missing)`;
      select.appendChild(missing);
    }
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label === o.value ? o.label : `${o.label} (${o.value})`;
      select.appendChild(opt);
    }
    const create = document.createElement('option');
    create.value = '\u0000new';
    create.textContent = 'New…';
    select.appendChild(create);
    select.value = current ?? '';
    select.addEventListener('change', () => {
      if (select.value === '\u0000new') {
        select.replaceWith(newOptionInput(relation, (name) => {
          hooks.createOption?.(relation, name);
          setValue(name);
          render();
        }, render));
        return;
      }
      setValue(select.value === '' ? null : select.value);
      render();
    });
    host.appendChild(select);

    const option = options.find((o) => o.value === current);
    if (option) {
      const link = document.createElement('button');
      link.className = 'mdw-fm-btn mdw-fm-rel-open';
      link.title = 'Open';
      link.textContent = '↗';
      link.addEventListener('click', () => hooks.openFile?.(option.path));
      host.appendChild(link);
    }
    return host;
  };

  const newOptionInput = (relation: Relation, onDone: (name: string) => void, onCancel: () => void): HTMLElement => {
    const input = document.createElement('input');
    input.className = 'mdw-fm-value mdw-fm-text';
    input.placeholder = `New ${relation.folder || 'option'}…`;
    input.spellcheck = false;
    let done = false;
    const finish = (commitValue: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (commitValue && name) onDone(name);
      else onCancel();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    requestAnimationFrame(() => input.focus());
    return input;
  };

  const relationPill = (v: string, option: PickerOption | undefined, onRemove: () => void): HTMLElement => {
    const pill = document.createElement('span');
    pill.className = 'mdw-fm-pill mdw-fm-rel';
    if (!option) pill.classList.add('mdw-fm-rel-missing');
    pill.title = option ? '⌘-click to open' : 'No such option';
    const text = document.createElement('span');
    text.textContent = option?.label ?? v;
    text.addEventListener('click', (e) => {
      if ((e.metaKey || e.ctrlKey) && option) {
        e.preventDefault();
        e.stopPropagation();
        hooks.openFile?.(option.path);
      }
    });
    const x = document.createElement('button');
    x.className = 'mdw-fm-pill-x';
    x.textContent = '✕';
    x.addEventListener('click', onRemove);
    pill.append(text, x);
    return pill;
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
