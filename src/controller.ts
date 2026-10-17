import * as vscode from "vscode";
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import { analyzeFile, AnalyzerError, PythonNotFoundError } from "./pythonBridge";
import { lineToIndex } from "./lineNumbers";
import type {
  AnalyzerResult,
  HostToWebview,
  WebviewState,
  WebviewToHost,
} from "./protocol";

interface CacheEntry {
  mtimeMs: number;
  result: AnalyzerResult;
}

export class CallGraphController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelReady = false;
  private panelDisposables: vscode.Disposable[] = [];
  private boundUri: vscode.Uri | undefined;
  private boundDocument: vscode.TextDocument | undefined;
  private lastResult: AnalyzerResult | undefined;
  private currentState: WebviewState | undefined;
  private analysisGeneration = 0;
  private analysisAbort: AbortController | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private cursorTimer: NodeJS.Timeout | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly output = vscode.window.createOutputChannel("PyCallMap");

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
      this.postState({ kind: "notPython" });
      return;
    }
    this.bind(editor.document);
    await this.refresh(true);
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
        this.panelReady = false;
        this.disposeListeners();
      }),
      this.panel.webview.onDidReceiveMessage((message: WebviewToHost) => {
        void this.onMessage(message);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChanged(event)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveEditorChanged(editor)),
      vscode.workspace.onDidSaveTextDocument((document) => this.onSaved(document)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pyCallMap")) {
          this.cache.clear();
          if (this.boundDocument) {
            void this.refresh(true);
          }
        }
      })
    );
  }

  private bind(document: vscode.TextDocument): void {
    if (this.boundUri?.toString() !== document.uri.toString()) {
      this.lastResult = undefined;
      this.currentState = undefined;
    }
    this.boundDocument = document;
    this.boundUri = document.uri;
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.type) {
      case "ready":
        this.panelReady = true;
        if (this.currentState) {
          this.post({ type: "state", state: this.currentState });
        } else if (this.lastResult) {
          this.postGraph(this.lastResult);
        }
        break;
      case "jump":
        await this.jump(message.line);
        break;
      case "refresh":
        await this.refresh(true);
        break;
      case "openSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "pyCallMap.pythonPath"
        );
        break;
    }
  }

  private post(message: HostToWebview): void {
    if (this.panel && this.panelReady) {
      void this.panel.webview.postMessage(message);
    }
  }

  private postState(state: WebviewState): void {
    this.currentState = state;
    this.post({ type: "state", state });
  }

  private postGraph(result: AnalyzerResult): void {
    this.currentState = undefined;
    const configuration = vscode.workspace.getConfiguration("pyCallMap");
    const showUncalled = configuration.get<boolean>("showUncalledByDefault", false);
    const warning =
      result.stats.functionCount > 300
        ? "Large graph: consider hiding uncalled functions."
        : undefined;
    this.post({ type: "graph", payload: result, showUncalled, warning });
  }

  private renderResult(result: AnalyzerResult): void {
    const errorDiagnostic = result.diagnostics.find((item) => item.severity === "error");
    if (errorDiagnostic) {
      this.lastResult = undefined;
      const detail =
        errorDiagnostic.line > 0
          ? `Line ${errorDiagnostic.line}: ${errorDiagnostic.message}`
          : errorDiagnostic.message;
      this.postState({
        kind: "error",
        title: "Syntax error",
        detail,
        canOpenSettings: false,
      });
      return;
    }
    if (result.functions.length === 0) {
      this.lastResult = undefined;
      this.postState({ kind: "empty" });
      return;
    }
    this.lastResult = result;
    this.postGraph(result);
  }

  private async refresh(force: boolean): Promise<void> {
    if (!this.panel) {
      return;
    }
    const document = this.boundDocument;
    if (!document) {
      return;
    }
    if (document.languageId !== "python") {
      this.postState({ kind: "notPython" });
      return;
    }
    let mtimeMs: number;
    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      mtimeMs = stat.mtime;
    } catch (error) {
      this.postState({
        kind: "error",
        title: "File unavailable",
        detail: String(error),
        canOpenSettings: false,
      });
      return;
    }
    const cacheKey = document.uri.fsPath;
    const cached = this.cache.get(cacheKey);
    if (!force && cached && cached.mtimeMs === mtimeMs) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      this.renderResult(cached.result);
      return;
    }
    const generation = ++this.analysisGeneration;
    this.analysisAbort?.abort();
    const abortController = new AbortController();
    this.analysisAbort = abortController;
    this.postState({ kind: "loading" });
    try {
      const result = await analyzeFile(
        document.uri.fsPath,
        {
          platform: process.platform,
          pathExists: (candidate) => fs.existsSync(candidate),
          workspaceFolder: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
          pythonPathSetting: vscode.workspace
            .getConfiguration("pyCallMap")
            .get<string>("pythonPath", ""),
        },
        this.context.asAbsolutePath("python/analyze.py"),
        {
          spawn: nodeSpawn,
          timeoutMs: 5000,
          maxOutputBytes: 10 * 1024 * 1024,
          signal: abortController.signal,
        }
      );
      if (generation !== this.analysisGeneration) {
        return;
      }
      this.cache.set(cacheKey, { mtimeMs, result });
      this.trimCache();
      this.renderResult(result);
    } catch (error) {
      if (generation !== this.analysisGeneration || abortController.signal.aborted) {
        return;
      }
      this.reportAnalysisError(error);
    }
  }

  private trimCache(): void {
    while (this.cache.size > 5) {
      const first = this.cache.keys().next();
      if (first.done) {
        break;
      }
      this.cache.delete(first.value);
    }
  }

  private reportAnalysisError(error: unknown): void {
    this.lastResult = undefined;
    if (error instanceof PythonNotFoundError) {
      this.output.appendLine(`[error] ${error.message}`);
      this.postState({
        kind: "error",
        title: "Python interpreter not found",
        detail:
          "Set pyCallMap.pythonPath to a Python executable, or create a .venv in the workspace.",
        canOpenSettings: true,
      });
      return;
    }
    const analyzerError =
      error instanceof AnalyzerError ? error : new AnalyzerError(String(error));
    this.output.appendLine(`[error] ${analyzerError.message}`);
    if (analyzerError.detail) {
      this.output.appendLine(analyzerError.detail);
    }
    const tail = analyzerError.detail
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-5)
      .join("\n");
    this.postState({
      kind: "error",
      title: analyzerError.message,
      detail: tail,
      canOpenSettings: false,
    });
  }

  private onSaved(document: vscode.TextDocument): void {
    if (!this.panel || !this.boundUri) {
      return;
    }
    if (document.uri.toString() !== this.boundUri.toString()) {
      return;
    }
    if (!vscode.workspace.getConfiguration("pyCallMap").get<boolean>("autoRefreshOnSave", true)) {
      return;
    }
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh(false);
    }, 300);
  }

  private onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    if (!this.panel || !editor) {
      return;
    }
    if (editor.document.languageId !== "python") {
      return;
    }
    if (this.boundUri && editor.document.uri.toString() === this.boundUri.toString()) {
      if (this.lastResult) {
        this.postGraph(this.lastResult);
      }
      return;
    }
    this.bind(editor.document);
    void this.refresh(false);
  }

  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.panel || !this.boundUri) {
      return;
    }
    if (event.textEditor.document.uri.toString() !== this.boundUri.toString()) {
      return;
    }
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
    }
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      const line = event.selections[0]?.active.line ?? 0;
      this.post({ type: "cursor", line: line + 1 });
    }, 100);
  }

  private async jump(line1Based: number): Promise<void> {
    if (!this.boundUri) {
      return;
    }
    let document = this.boundDocument;
    if (!document || document.uri.toString() !== this.boundUri.toString()) {
      document = await vscode.workspace.openTextDocument(this.boundUri);
    }
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === this.boundUri?.toString()
    );
    const line = lineToIndex(line1Based);
    const position = new vscode.Position(line, 0);
    const selection = new vscode.Range(position, position);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: visibleEditor?.viewColumn ?? vscode.ViewColumn.One,
      selection,
      preserveFocus: false,
    });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  }

  private disposeListeners(): void {
    for (const disposable of this.panelDisposables) {
      disposable.dispose();
    }
    this.panelDisposables = [];
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = undefined;
    }
    this.analysisAbort?.abort();
    this.analysisAbort = undefined;
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
    this.disposeListeners();
    this.panel?.dispose();
    this.panel = undefined;
    this.output.dispose();
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
