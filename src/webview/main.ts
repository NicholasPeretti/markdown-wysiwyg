import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { Selection } from '@milkdown/kit/prose/state';
import { replaceAll } from '@milkdown/kit/utils';
import { emojiPlugin } from './emoji';
import { addCalloutSlashItems, calloutPlugin, unescapeCallouts } from './callouts';
import { applySlashAliases } from './slash_aliases';
import {
  handleQueryMessage,
  installQueryTables,
  queryLanguage,
  renderQueryPreview,
  addQuerySlashItem,
} from './query_table';
import { createToc, type Toc } from './toc';
import { installLinkHandler } from './links';
import { htmlInlineInputRule, htmlInlinePlugin } from './html_inline';
import {
  composeDocument,
  createFrontmatterPanel,
  splitFrontmatter,
  type FrontmatterPanel,
} from './frontmatter';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('editor')!;

let crepe: Crepe | undefined;
let toc: Toc | undefined;
let tocVisible = true;
let frontmatterPanel: FrontmatterPanel | undefined;
let lastSentText: string | undefined;
// Milkdown's listener debounces markdownUpdated, so the echo of an external
// replaceAll arrives late. Swallow exactly one event after an external apply
// (with a timeout fallback), otherwise the echo would be sent back as an edit
// and spuriously dirty the document — which blocks VS Code's hot reload.
let swallowNextUpdate = false;
let swallowTimer: ReturnType<typeof setTimeout> | undefined;

function armSwallow(): void {
  swallowNextUpdate = true;
  clearTimeout(swallowTimer);
  swallowTimer = setTimeout(() => {
    swallowNextUpdate = false;
  }, 600);
}

function editorMarkdown(): string {
  return unescapeCallouts(crepe?.getMarkdown() ?? '');
}

function currentDocument(): string {
  return composeDocument(frontmatterPanel?.get() ?? null, editorMarkdown());
}

function sendEdit(): void {
  const text = currentDocument();
  lastSentText = text;
  vscode.postMessage({ type: 'edit', text });
}

async function createEditor(initial: string): Promise<void> {
  const { fm, body } = splitFrontmatter(initial);

  const fmHost = document.createElement('div');
  fmHost.id = 'frontmatter-host';
  root.before(fmHost);
  frontmatterPanel = createFrontmatterPanel(fmHost, sendEdit);
  frontmatterPanel.set(fm);

  crepe = new Crepe({
    root,
    defaultValue: body,
    featureConfigs: {
      [Crepe.Feature.BlockEdit]: {
        buildMenu: (builder) => {
          addCalloutSlashItems(builder);
          addQuerySlashItem(builder);
          applySlashAliases(builder, crepe!.editor.ctx);
        },
      },
      [Crepe.Feature.CodeMirror]: {
        languages: [queryLanguage],
        renderPreview: renderQueryPreview,
        previewOnlyByDefault: true,
        previewLabel: 'Result',
        previewLoading: 'Querying…',
      },
    },
  });

  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown, prev) => {
      if (swallowNextUpdate) {
        swallowNextUpdate = false;
        clearTimeout(swallowTimer);
        return;
      }
      if (markdown === prev) {
        return;
      }
      sendEdit();
    });
  });

  crepe.editor.use(emojiPlugin);
  crepe.editor.use(calloutPlugin);
  crepe.editor.use(htmlInlinePlugin);
  crepe.editor.use(htmlInlineInputRule);

  await crepe.create();

  // Clicking the empty area below the content (the padding of #editor /
  // body) puts the caret at the end of the document, like a text editor.
  const focusEnd = (e: MouseEvent) => {
    if (e.button !== 0 || !crepe) {
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('.ProseMirror, .milkdown-slash-menu, .mdw-toc, #frontmatter-host')) {
      return;
    }
    const pm = root.querySelector<HTMLElement>('.ProseMirror');
    if (!pm || e.clientY < pm.getBoundingClientRect().bottom) {
      return;
    }
    e.preventDefault();
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { tr, doc } = view.state;
      view.dispatch(tr.setSelection(Selection.atEnd(doc)).scrollIntoView());
      view.focus();
    });
  };
  document.body.addEventListener('mousedown', focusEnd);

  toc = createToc(root, tocVisible);
}

window.addEventListener('message', async (event) => {
  const message = event.data;
  if (message && handleQueryMessage(message)) {
    return;
  }
  if (message?.type === 'toggleToc') {
    const visible = toc?.toggle() ?? false;
    vscode.postMessage({ type: 'tocVisible', value: visible });
    return;
  }
  if (message?.type !== 'update') {
    return;
  }
  const text: string = message.text;

  if (!crepe) {
    tocVisible = message.tocVisible ?? true;
    await createEditor(text);
    return;
  }

  // Ignore the echo of an edit we just sent.
  if (text === lastSentText || text === currentDocument()) {
    return;
  }

  const { fm, body } = splitFrontmatter(text);
  frontmatterPanel?.set(fm);

  if (body !== editorMarkdown()) {
    armSwallow();
    crepe.editor.action(replaceAll(body));
  }
});

installLinkHandler((href) => vscode.postMessage({ type: 'openLink', href }));
installQueryTables({
  post: (message) => vscode.postMessage(message),
  ctx: () => crepe?.editor.ctx,
});

vscode.postMessage({ type: 'ready' });
