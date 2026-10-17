import * as vscode from "vscode";
import type { HostToWebview, WebviewToHost } from "./protocol";

export class CallGraphController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly panelDisposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("Open a Python file first.");
      return;
    }
    this.ensurePanel();
    this.panel?.reveal(undefined, true);
    if (editor.document.languageId !== "python") {
      this.post({ type: "state", state: { kind: "notPython" } });
    }
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "pyCallMap",
      "PyCallMap",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      }
    );
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panelDisposables.push(
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }),
      this.panel.webview.onDidReceiveMessage((message: WebviewToHost) => {
        if (message?.type === "ready") {
          // Task 7 replaces this stub with the real analysis pipeline.
          this.post({ type: "state", state: { kind: "empty" } });
        }
      })
    );
  }

  private post(message: HostToWebview): void {
    void this.panel?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>PyCallMap</title>
</head>
<body>
  <div id="app">
    <header id="toolbar">
      <span id="title">PyCallMap</span>
      <span id="file"></span>
      <span class="spacer"></span>
      <button id="refresh" title="Refresh">&#x21bb;</button>
      <button id="fit" title="Fit">&#x2922;</button>
      <button id="toggle-uncalled" title="Show uncalled functions">&#x1f441;</button>
    </header>
    <div id="banner" hidden></div>
    <div id="canvas-wrap">
      <div id="canvas"></div>
      <div id="tooltip" hidden></div>
      <div id="overlay">
        <div id="overlay-content"></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panel?.dispose();
    this.panel = undefined;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
