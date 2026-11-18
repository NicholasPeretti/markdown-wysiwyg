# Markdown WYSIWYG

Edit markdown files in a Notion-style WYSIWYG editor (powered by [Milkdown](https://milkdown.dev/)), and switch back to VS Code's regular text editor at any time. The markdown file stays the single source of truth — edits in either mode write to the same document.

## Features

- **WYSIWYG mode** — Notion-style editing with a `/` slash menu, drag handles, tables, code blocks, task lists, and more (Milkdown Crepe).
- **Code mode** — the normal VS Code markdown text editor.
- **One-click switching** — toolbar icons in the editor title bar, or the command palette:
  - `Markdown: Open in WYSIWYG Mode`
  - `Markdown: Open in Code Mode`
- **Live sync** — the WYSIWYG view edits the real `TextDocument`, so undo/redo, dirty state, and save all behave normally.
- **Callouts** — GitHub-style alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) render as colored callouts. Insert one from the `/` menu, or click a callout's title to change its kind.
- **Subscript / superscript** — `H<sub>2</sub>O`, `x<sup>2</sup>` render inline; type the tags to create them, cursor inside reveals them.
- **Find** — Cmd/Ctrl+F opens a VS Code-style find bar with match count and highlighting; Enter/⇧Enter (or Cmd/Ctrl+G) step through matches, Escape leaves the cursor on the current one.
- **Cmd/Ctrl+click links** — opens links in the body and URLs in frontmatter fields, like the text editor. Relative paths open in VS Code.
- **Mermaid diagrams** — ```` ```mermaid ```` blocks render as diagrams (insert with `/diagram`); flowcharts are shown in whichever orientation (LR/TD) fits the page better — add a `%% keep-direction` comment to opt out; toggle back to the source with the code block's preview button. Hover a diagram for zoom controls (−/+/Reset, or ⌘-scroll; drag to pan when zoomed) and ⛶ to open it full screen (`+`/`-` zoom, `0` fit, `Esc` close).
- **Query tables** — Notion-style live tables of workspace files. A ```` ```query ```` fenced block (insert with `/query`) renders as a table; see [Query tables](#query-tables) below.
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
| `where` | Filter expression; repeat the line to AND several. Operators: `==` `!=` `<` `<=` `>` `>=` `contains` `startsWith` `endsWith` `matches` `exists`, combined with `and` / `or` / `not` and parentheses. |
| `sort` | `<field> asc|desc`. Default: `file.modified desc`. Click a column header to change it. |
| `limit` | Max rows (default 50). |
| `page` | Page size; shows a pager in the table header. |
| `columns` | Columns to show. Default: `file.name, file.path, file.modified` plus any fields used in `where`/`sort`. |

Fields: `file.path`, `file.name`, `file.folder`, `file.modified`, `file.created`, `file.size`, and any frontmatter field (`status`, `tags`, `meta.owner`, optionally prefixed `fm.`). Values: `"strings"`, numbers, `true`/`false`/`null`, `/regex/i`, `YYYY-MM-DD`, and `today`/`now ± 7d|2w|1m|1y`. Missing fields compare like Notion: `!=` is true, everything else is false.

- **Cmd/Ctrl+click** a row to open the file.
- **Double-click** a cell to edit it in place: frontmatter fields are rewritten in the target file (comments and formatting preserved; booleans toggle, arrays take `a, b, c`, an empty value removes the field) and `file.name` renames the file. Open files are edited in their buffer and saved unless they already had unsaved changes.
- The table footer has a ✎ toggle to edit the query and a **⋯** menu (top right of the table, shown on hover) with **Copy as Markdown** (static table of the current result) and **Copy query**.
- Results refresh automatically when files change; run **Markdown WYSIWYG: Rebuild Query Index** if they look stale.
- Completions for keys, fields, operators and known values appear while editing the query, both in the WYSIWYG block and in the text editor.

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
