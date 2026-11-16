import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/kit/utils';
import { emojiPlugin } from './emoji';
import { createToc, type Toc } from './toc';
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

function currentDocument(): string {
  return composeDocument(
    frontmatterPanel?.get() ?? null,
    crepe?.getMarkdown() ?? ''
  );
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

  await crepe.create();

  toc = createToc(root, tocVisible);
}

window.addEventListener('message', async (event) => {
  const message = event.data;
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

  if (body !== crepe.getMarkdown()) {
    armSwallow();
    crepe.editor.action(replaceAll(body));
  }
});

vscode.postMessage({ type: 'ready' });
