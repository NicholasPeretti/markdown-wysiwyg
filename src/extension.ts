import * as vscode from 'vscode';

const VIEW_TYPE = 'markdownWysiwyg.editor';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new MarkdownWysiwygProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    ),

    vscode.commands.registerCommand('markdownWysiwyg.openWysiwyg', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),

    vscode.commands.registerCommand('markdownWysiwyg.openSource', (uri?: vscode.Uri) => {
      const target = uri ?? activeCustomEditorUri;
      if (!target) {
        return;
      }
      vscode.commands.executeCommand('vscode.openWith', target, 'default');
    })
  );
}

/** Tracks the document shown in the focused WYSIWYG editor, for the toggle command. */
let activeCustomEditorUri: vscode.Uri | undefined;

class MarkdownWysiwygProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    activeCustomEditorUri = document.uri;

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    // True while an edit from the webview is being applied, to avoid echoing
    // the document-change event back into the webview.
    let applyingWebviewEdit = false;

    const postContent = () => {
      webviewPanel.webview.postMessage({ type: 'update', text: document.getText() });
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

    const viewStateSub = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        activeCustomEditorUri = document.uri;
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          postContent();
          break;
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
      viewStateSub.dispose();
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
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Markdown WYSIWYG</title>
</head>
<body>
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
