# Markdown WYSIWYG

Edit markdown files in a Notion-style WYSIWYG editor (powered by [Milkdown](https://milkdown.dev/)), and switch back to VS Code's regular text editor at any time. The markdown file stays the single source of truth — edits in either mode write to the same document.

## Features

- **WYSIWYG mode** — Notion-style editing with a `/` slash menu, drag handles, tables, code blocks, task lists, and more (Milkdown Crepe).
- **Code mode** — the normal VS Code markdown text editor.
- **One-click switching** — toolbar icons in the editor title bar, or the command palette:
  - `Markdown: Open in WYSIWYG Mode`
  - `Markdown: Open in Code Mode`
- **Live sync** — the WYSIWYG view edits the real `TextDocument`, so undo/redo, dirty state, and save all behave normally.
- Matches your VS Code color theme.

## Usage

1. Open any `.md` file (opens in code mode by default).
2. Click the preview icon in the editor title bar, or run **Markdown: Open in WYSIWYG Mode**.
3. To return, click the code icon or run **Markdown: Open in Code Mode**.

You can also right-click a file → **Open With…** → **Markdown WYSIWYG**, and set it as the default for markdown if you prefer WYSIWYG-first.

## Development

```bash
npm install
npm run build     # or: npm run watch
```

Press **F5** in VS Code to launch an Extension Development Host.

To build an installable package:

```bash
npx @vscode/vsce package
code --install-extension markdown-wysiwyg-0.0.1.vsix
```

## Notes

- Markdown is round-tripped through Milkdown's parser/serializer. Formatting is preserved semantically, but whitespace/style details (e.g. `*` vs `-` bullets) may be normalized when you edit in WYSIWYG mode.
