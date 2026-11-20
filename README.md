# Markdown WYSIWYG

Edit markdown files in a Notion-style WYSIWYG editor (powered by [Milkdown](https://milkdown.dev/)), and switch back to VS Code's regular text editor at any time. The markdown file stays the single source of truth — edits in either mode write to the same document.

## Features

- **WYSIWYG mode** — Notion-style editing with a `/` slash menu, drag handles, tables, code blocks, task lists, and more (Milkdown Crepe).
- **Block menu** — click the ⠿ grip of a block's drag handle to *turn it into* text, a heading, a bullet/numbered/task list, a quote or code, or to delete the whole block. Converting a single list item splits the list around it; from the first item the whole list is converted.
- **Code mode** — the normal VS Code markdown text editor.
- **One-click switching** — toolbar icons in the editor title bar, or the command palette:
  - `Markdown: Open in WYSIWYG Mode`
  - `Markdown: Open in Code Mode`
- **Live sync** — the WYSIWYG view edits the real `TextDocument`, so undo/redo, dirty state, and save all behave normally.
- **Callouts** — GitHub-style alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) and Obsidian's extra kinds (`[!ABSTRACT]`, `[!INFO]`, `[!TODO]`, `[!SUCCESS]`, `[!QUESTION]`, `[!FAILURE]`, `[!DANGER]`, `[!BUG]`, `[!EXAMPLE]`, `[!QUOTE]`, plus aliases such as `[!TLDR]`, `[!HINT]`, `[!HELP]`, `[!ERROR]`) render as colored callouts. Insert one from the `/` menu, or click a callout's title to change its kind.
- **Subscript / superscript** — `H<sub>2</sub>O`, `x<sup>2</sup>` render inline; type the tags to create them, cursor inside reveals them.
- **Find** — Cmd/Ctrl+F opens a VS Code-style find bar with match count and highlighting; Enter/⇧Enter (or Cmd/Ctrl+G) step through matches, Escape leaves the cursor on the current one.
- **Search notes** — ⇧⌥⌘F (Ctrl+Shift+Alt+F), **Markdown: Search Notes**, or the Notes icon in the activity bar opens a sidebar modelled on VS Code's Search view, ranked by BM25 over the full text of every Markdown file in the workspace (file name and `title` weigh more). Every word must match; the last word also matches as a prefix while you type; light stemming (`tables` finds `table`). Results show "N results in M files", each file with its path, match count and best matching lines (terms highlighted); switch between list and folder tree, collapse/expand all, clear. Keyboard: ↓ from the box enters the results, ↑/↓ cycle (wrapping), ←/→/Space fold, Enter opens the note in the WYSIWYG editor with the find bar on that line, ⌥-click or `</>` opens the source at the line; F4 / ⇧F4 step through results from anywhere. The index is the same one query tables use, so results refresh as files change.
- **Cmd/Ctrl+click links** — opens links in the body and URLs in frontmatter fields, like the text editor. Relative paths open in VS Code. Mouse back/forward buttons navigate VS Code's editor history, as they do elsewhere.
- **Local images** — `![alt](assets/pic.png)` renders from a path relative to the document (anywhere in the workspace, or next to the file), as well as from `https:` URLs.
- **Mermaid diagrams** — ```` ```mermaid ```` blocks render as diagrams (insert with `/diagram`); flowcharts are shown in whichever orientation (LR/TD) fits the page better — add a `%% keep-direction` comment to opt out; toggle back to the source with the code block's preview button. Hover a diagram for zoom controls (−/+/Reset, or ⌘-scroll; drag to pan when zoomed) and ⛶ to open it full screen (`+`/`-` zoom, `0` fit, `Esc` close).
- **Query tables** — Notion-style live tables of workspace files. A ```` ```query ```` fenced block (insert with `/query`) renders as a table; see [Query tables](#query-tables) below.
- **Relations** — Notion-style relation fields whose options are the files of another folder (tags, people, statuses…): chips with autocomplete or a dropdown. Declared per file under `$relations:`, editable from the properties panel; see [Relations](#relations) below.
- Matches your VS Code color theme.

## Usage

1. Open any `.md` file (opens in code mode by default).
2. Click the preview icon in the editor title bar, or run **Markdown: Open in WYSIWYG Mode**.
3. To return, click the code icon or run **Markdown: Open in Code Mode**.

You can also right-click a file → **Open With…** → **Markdown WYSIWYG**, and set it as the default for markdown if you prefer WYSIWYG-first.

## Query tables

A fenced code block with language `query` renders as a live table of the markdown files in your workspace, filtered by path, frontmatter and file metadata. The block stays plain markdown (other viewers show the query text).

````markdown
```query
from: notes
where: draft == true and tags contains "kibana"
sort: file.modified desc
limit: 10
columns: file.name, title, status, file.modified
```
````

| Key | Meaning |
| --- | --- |
| `from` | Folder (recursive) or glob, relative to the workspace folder. Default: whole workspace. |
| `where` | Filter expression; repeat the line to AND several. Operators: `==` `!=` `<` `<=` `>` `>=` `contains` (alias `includes`) `startsWith` `endsWith` `matches` `exists`, combined with `and` / `or` / `not` and parentheses. |
| `sort` | `<field> asc|desc`. Default: `file.modified desc`. Click a column header to change it. |
| `limit` | Max rows (default 50; no cap when `page_size` is set). |
| `page_size` | Rows per page; shows a ‹ › pager in the table header so every matching file is reachable without a tall table. Alias: `page`. |
| `columns` | Columns to show. Default: `file.name, file.path, file.modified` plus any fields used in `where`/`sort`. |
| `group` | Group rows under a folding header per value of this field (a file with an array value, e.g. `tags`, appears in each of its groups). Groups follow the `sort` direction of that field, if any; `page_size` is ignored. |
| `distinct` | List the unique values of this field with a file count instead of files (columns `<field>`, `count`). Default sort: `count desc`; `limit` caps the number of values. Cannot be combined with `group`. |

Fields: `file.path`, `file.name`, `file.folder`, `file.modified`, `file.created`, `file.size`, and any frontmatter field (`status`, `tags`, `meta.owner`, optionally prefixed `fm.`). Values: `"strings"`, numbers, `true`/`false`/`null`, `/regex/i`, `YYYY-MM-DD`, and `today`/`now ± 7d|2w|1m|1y`. Empty fields (missing, `null`, `""` or an empty list such as a relation with no items) compare like Notion: `== null` and `== ""` match them, `!=` is true, everything else is false.

### Following relations

A field path can step through a [relation](#relations) into the linked file: `tasks.active` reads `active` from the task(s) a research file names in `tasks`, `parent.title` the parent's title, `tasks.parent.done` as deep as you like. If the first segment is not a relation of that file, the path is a nested frontmatter object as before (`meta.owner`). A `multi` relation yields a list, which matches when any item does.

```query
from: research
where: tasks.active == true and tasks.done == false
```

`field*` follows the relation repeatedly and collects the file itself plus everything reached (cycle-safe, at most 32 hops); `field+` leaves the file itself out. So in a task file, `parent*.tasks includes $.file.name` lists its research and every sub-research under it, and `count(parent+)` is a file's depth in the tree.

Aggregates reduce a path to one value and work wherever a field does (`where`, `sort`, `columns`, `group`, `distinct`): `count(p)` (0 when empty), `sum(p)`, `avg(p)`, `min(p)`, `max(p)` — e.g. `columns: title, count(tasks)`, `sort: max(tasks.due) asc`. Columns that go through a relation or aggregate are read-only; values from linked files show as pills that **Cmd/Ctrl+click** opens. With several linked files, `tasks.active == true and tasks.done == false` holds when *some* task is active and *some* task is not done (like Notion rollups).

`$.field` stands for the current file's own frontmatter value, so a query can follow the file it lives in. If the value is a list, a clause matches when any item does (`!=` when none does). Results update live as you edit the properties panel.

```query
from: tasks
where: tags includes $.name
```

- **Cmd/Ctrl+click** a row to open the file. **Right-click** a row for **Open** and **Delete…** (asks for confirmation, then moves the file to the Trash).
- Cells are editable in place and the target file's frontmatter is rewritten (comments and formatting preserved). Booleans are checkboxes; lists are pills with a hover ✕ and a `+` to add; relations are pills/dropdowns opening the option picker. Empty cells take the shape of their column so a value can be added. **Double-click** text, number and date cells to type (an empty value removes the field; `file.name` renames the file). Open files are edited in their buffer and saved unless they already had unsaved changes.
- A **+ New** row at the bottom creates a file, Notion-style. Type a name (validated as you type: not empty, no `\ / : * ? " < > |`, no clash with an existing file) and press `Enter`; `Esc` cancels. The file goes in the `from` folder (or the current file's folder when there is no `from`; the row is hidden when `from` is a glob or for `distinct` queries). Its frontmatter is pre-filled from the `==`/`contains` terms of `where` so it matches the query, with an empty value for every other column and the `$relations` its siblings declare; the new row is highlighted once it appears.
- A toolbar above the header (it stays visible while you scroll) holds a **Filter rows…** box at the left and, on hover, a ✎ toggle to edit the query plus a **⋯** menu at the right with **Copy as Markdown** (static table of the current result) and **Copy query**.
- Filtering keeps the rows whose visible cells contain every typed word (case-insensitive; groups shrink accordingly, the pager and count follow). The filter is never written to the file; `Esc` clears it.
- Results refresh automatically when files change — including folders moved or deleted by other tools — and the index is re-checked against the file system before each query and whenever the window or panel regains focus. **Markdown WYSIWYG: Rebuild Query Index** forces a full rebuild.
- Completions for keys, fields, operators and known values appear while editing the query, both in the WYSIWYG block and in the text editor.

## Relations

A file can declare in its own frontmatter that some of its fields are **relations** — fields whose values come from the files of another folder, like a Notion relation property. Declarations live under the reserved `$relations` key (the `$` keeps it apart from your own fields):

```yaml
---
title: Query items
$relations:
  tags:            # chips with autocomplete
    from: tags
    field: name
    multi: true
  status:          # dropdown
    from: statuses
    field: name
---
```

Declarations are managed from the collapsed **Relations** section at the bottom of the properties panel (not shown as a regular property): `+` opens a small form, click a declaration to edit it, ✕ removes it.

| Key | Meaning |
| --- | --- |
| `from` | Folder holding the options (workspace-relative; `./x` is relative to the file). Every markdown file in it is an option, except its `index.md`/`README.md`. |
| `field` | Frontmatter field of the option file whose value is stored (e.g. `name: urgent` in `tags/urgent.md`). Default: the option's file name. |
| `multi` | `true` → list of values, shown as chips with autocomplete. Default `false` → single value, shown as a dropdown. |

Declared fields appear in the properties panel even when the file doesn't have them yet; the first value you pick adds the field. Option labels use the option file's `title` when present.

- **Properties panel** — `multi` fields are chips: type to filter, Enter adds, `Create "x"` writes `from/x.md` (with `field: x` in its frontmatter). Single fields are a dropdown of the existing options. Cmd/Ctrl+click a chip (or the ↗ next to a dropdown) opens the option file.
- **Query tables** — `multi` relations are pills with a `+` that opens the picker; single ones are a dropdown. Changes write the target file's frontmatter. Cmd/Ctrl+click a pill opens the option file. Values with no matching option show as dashed pills.

Since relations are plain frontmatter, put them in your templates so every new file gets them. The option file can list its users with a `$.field` query, e.g. `where: tags includes $.name` in `tags/urgent.md`.

## Development

```bash
npm install
npm run build     # or: npm run watch
```

Press **F5** in VS Code to launch an Extension Development Host.

To build an installable package:

```bash
npx @vscode/vsce package
code --install-extension markdown-wysiwyg-0.1.0.vsix
```

## Notes

- Markdown is round-tripped through Milkdown's parser/serializer. Formatting is preserved semantically, but whitespace/style details (e.g. `*` vs `-` bullets) may be normalized when you edit in WYSIWYG mode.
