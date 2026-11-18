import * as vscode from 'vscode';
import { FileIndex, runQuery } from './query/host';
import { renameMarkdownFile, setFrontmatterField, type EditKind } from './query/edit';
import { complete } from './query/complete';

const VIEW_TYPE = 'markdownWysiwyg.editor';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new MarkdownWysiwygProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
        supportsMultipleEditorsPerDocument: false,
      }
    ),

    vscode.commands.registerCommand('markdownWysiwyg.openWysiwyg', (uri?: vscode.Uri) => {
      const target = uri ?? activeTabUri() ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      codeModeUris.delete(target.toString());
      reopenWith(target, VIEW_TYPE);
    }),

    vscode.commands.registerCommand('markdownWysiwyg.openSource', (uri?: vscode.Uri) => {
      const target = uri ?? activeCustomEditorUri;
      if (!target) {
        return;
      }
      codeModeUris.add(target.toString());
      reopenWith(target, 'default');
    }),

    vscode.commands.registerCommand('markdownWysiwyg.toggleToc', () => {
      activePanel?.webview.postMessage({ type: 'toggleToc' });
    }),

    vscode.commands.registerCommand('markdownWysiwyg.rebuildQueryIndex', async () => {
      await Promise.all([...indexes.values()].map((index) => index.rebuild()));
      vscode.window.setStatusBarMessage('Markdown query index rebuilt', 3000);
    }),

    vscode.languages.registerCompletionItemProvider(
      'markdown',
      new QueryCompletionProvider(),
      ':', ' ', '.', '"', ','
    ),

    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.removed) {
        indexes.get(folder.uri.toString())?.dispose();
        indexes.delete(folder.uri.toString());
      }
    }),

    { dispose: () => indexes.forEach((index) => index.dispose()) },

    // VS Code's editor history can reopen markdown as plain text (e.g. after
    // viewing a diff). Redirect such tabs back to WYSIWYG, unless the user
    // explicitly switched that file to code mode.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.opened) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputText &&
          input.uri.scheme === 'file' &&
          /\.(md|markdown)$/i.test(input.uri.path) &&
          !codeModeUris.has(input.uri.toString())
        ) {
          reopenWith(input.uri, VIEW_TYPE, tab.group);
        }
      }
    })
  );
}

/** One query index per workspace folder, created lazily. */
const indexes = new Map<string, FileIndex>();

function indexFor(uri: vscode.Uri): FileIndex | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const key = folder.uri.toString();
  let index = indexes.get(key);
  if (!index) {
    index = new FileIndex(folder);
    indexes.set(key, index);
  }
  return index;
}

/** Completions inside ```query fences of a plain-text Markdown editor. */
class QueryCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!insideQueryFence(document, position.line)) return undefined;
    const index = indexFor(document.uri);
    if (!index) return undefined;
    await index.ensure();
    const line = document.lineAt(position.line).text;
    const result = complete(line, position.character, index.completionContext());
    if (!result) return undefined;
    const range = new vscode.Range(position.line, result.from, position.line, position.character);
    const kinds: { [k: string]: vscode.CompletionItemKind } = {
      key: vscode.CompletionItemKind.Property,
      field: vscode.CompletionItemKind.Field,
      operator: vscode.CompletionItemKind.Operator,
      value: vscode.CompletionItemKind.Value,
      folder: vscode.CompletionItemKind.Folder,
      keyword: vscode.CompletionItemKind.Keyword,
    };
    return result.items.map((item, i) => {
      const ci = new vscode.CompletionItem(item.label, kinds[item.kind]);
      ci.insertText = item.insert ?? item.label;
      ci.range = range;
      ci.detail = item.detail;
      ci.sortText = String(i).padStart(4, '0');
      return ci;
    });
  }
}

function insideQueryFence(document: vscode.TextDocument, line: number): boolean {
  let open = false;
  for (let i = 0; i < line; i++) {
    const text = document.lineAt(i).text;
    if (/^\s*(```|~~~)/.test(text)) {
      if (open) {
        open = false;
      } else if (/^\s*(```|~~~)\s*query\s*$/i.test(text)) {
        open = true;
      } else {
        // Some other fence: skip to its close.
        open = false;
        for (i++; i < line; i++) {
          if (/^\s*(```|~~~)/.test(document.lineAt(i).text)) break;
        }
      }
    }
  }
  return open;
}

/** Files the user explicitly switched to code mode this session. */
const codeModeUris = new Set<string>();

/** Tracks the document shown in the focused WYSIWYG editor, for the toggle command. */
let activeCustomEditorUri: vscode.Uri | undefined;
/** The most recently focused WYSIWYG webview panel. */
let activePanel: vscode.WebviewPanel | undefined;

/** Resource of the active tab, regardless of editor type. For diff views, the modified side. */
function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === 'file') {
    return input.modified;
  }
  return undefined;
}

/**
 * Reopens `uri` with the given editor in place. Uses VS Code's own
 * reopen-with command, which swaps the editor input rather than closing the
 * tab, so a dirty document does not trigger a save prompt. Falls back to
 * open-then-close when no tab exists for the resource (e.g. diff views).
 */
async function reopenWith(
  uri: vscode.Uri,
  viewType: string,
  group: vscode.TabGroup = vscode.window.tabGroups.activeTabGroup
): Promise<void> {
  const isSameResource = (tab: vscode.Tab) => {
    const input = tab.input;
    return (
      (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) &&
      input.uri.toString() === uri.toString()
    );
  };

  if (group.tabs.some(isSameResource)) {
    await vscode.commands.executeCommand('reopenActiveEditorWith', viewType, uri);
    return;
  }

  await vscode.commands.executeCommand('vscode.openWith', uri, viewType, group.viewColumn);
}

class MarkdownWysiwygProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    activeCustomEditorUri = document.uri;
    activePanel = webviewPanel;

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    // True while an edit from the webview is being applied, to avoid echoing
    // the document-change event back into the webview.
    let applyingWebviewEdit = false;

    const postContent = () => {
      webviewPanel.webview.postMessage({
        type: 'update',
        text: document.getText(),
        tocVisible: this.context.globalState.get('tocVisible', true),
      });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (applyingWebviewEdit || e.contentChanges.length === 0) {
        return;
      }
      postContent();
    });

    const indexSub = indexFor(document.uri)?.onDidChange(() => {
      webviewPanel.webview.postMessage({ type: 'queryRefresh' });
    });

    const viewStateSub = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        activeCustomEditorUri = document.uri;
        activePanel = webviewPanel;
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          postContent();
          break;
        case 'tocVisible':
          this.context.globalState.update('tocVisible', message.value);
          break;
        case 'openLink':
          await openLink(String(message.href), document.uri);
          break;
        case 'openFile': {
          const index = indexFor(document.uri);
          if (index) {
            const target = vscode.Uri.joinPath(index.folder.uri, String(message.path));
            await vscode.commands.executeCommand('vscode.open', target);
          }
          break;
        }
        case 'query': {
          const index = indexFor(document.uri);
          if (!index) {
            webviewPanel.webview.postMessage({ type: 'queryError', id: message.id, message: 'No workspace folder open' });
            break;
          }
          await index.ensure();
          const result = runQuery(String(message.text), index.records());
          if ('error' in result) {
            webviewPanel.webview.postMessage({ type: 'queryError', id: message.id, message: result.error });
          } else {
            webviewPanel.webview.postMessage({ type: 'queryResult', id: message.id, ...result });
          }
          break;
        }
        case 'queryContext': {
          const index = indexFor(document.uri);
          if (!index) break;
          await index.ensure();
          webviewPanel.webview.postMessage({ type: 'queryContextResult', id: message.id, ...index.completionContext() });
          break;
        }
        case 'setField':
        case 'renameFile': {
          const index = indexFor(document.uri);
          if (!index) break;
          const target = vscode.Uri.joinPath(index.folder.uri, String(message.path));
          try {
            if (message.type === 'setField') {
              await setFrontmatterField(target, String(message.field), String(message.value), message.kind as EditKind);
            } else {
              await renameMarkdownFile(target, String(message.value));
            }
          } catch (err) {
            void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
            webviewPanel.webview.postMessage({ type: 'queryRefresh' });
          }
          break;
        }
        case 'edit': {
          const incoming: string = message.text;
          if (incoming === document.getText()) {
            return;
          }
          applyingWebviewEdit = true;
          try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              document.uri,
              new vscode.Range(0, 0, document.lineCount, 0),
              incoming
            );
            await vscode.workspace.applyEdit(edit);
          } finally {
            applyingWebviewEdit = false;
          }
          break;
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      indexSub?.dispose();
      viewStateSub.dispose();
      if (activePanel === webviewPanel) {
        activePanel = undefined;
      }
      if (activeCustomEditorUri?.toString() === document.uri.toString()) {
        activeCustomEditorUri = undefined;
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Markdown WYSIWYG</title>
</head>
<body>
  <div id="editor"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Opens http(s)/mailto links externally; other paths resolve relative to the document. */
async function openLink(href: string, from: vscode.Uri): Promise<void> {
  if (/^(https?|mailto):/i.test(href)) {
    await vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  if (href.startsWith('#')) {
    return;
  }
  const [path] = href.split('#');
  const target = path.startsWith('/')
    ? vscode.Uri.file(path)
    : vscode.Uri.joinPath(from, '..', decodeURIComponent(path));
  await vscode.commands.executeCommand('vscode.open', target);
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
