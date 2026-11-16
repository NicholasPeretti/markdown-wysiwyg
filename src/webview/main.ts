import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/kit/utils';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('editor')!;

let crepe: Crepe | undefined;
let lastSentMarkdown: string | undefined;
// True while applying an update that came from the extension host, so the
// resulting markdownUpdated event is not echoed back as an edit.
let applyingExternalUpdate = false;

async function createEditor(initial: string): Promise<void> {
  crepe = new Crepe({
    root,
    defaultValue: initial,
  });

  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown, prev) => {
      if (applyingExternalUpdate || markdown === prev) {
        return;
      }
      lastSentMarkdown = markdown;
      vscode.postMessage({ type: 'edit', text: markdown });
    });
  });

  await crepe.create();
}

window.addEventListener('message', async (event) => {
  const message = event.data;
  if (message?.type !== 'update') {
    return;
  }
  const text: string = message.text;

  if (!crepe) {
    await createEditor(text);
    return;
  }

  // Ignore the echo of an edit we just sent.
  if (text === lastSentMarkdown || text === crepe.getMarkdown()) {
    return;
  }

  applyingExternalUpdate = true;
  try {
    crepe.editor.action(replaceAll(text));
  } finally {
    applyingExternalUpdate = false;
  }
});

vscode.postMessage({ type: 'ready' });
