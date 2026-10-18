import * as vscode from "vscode";
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import {
  analyzeFile,
  AnalyzerError,
  PythonNotFoundError,
} from "./pythonBridge";
import { lineToIndex } from "./lineNumbers";
import { analyzeNotebook } from "./notebookAnalysis";
import {
  cellRangeFor,
  concatLineToCell,
  type NotebookSource,
} from "./notebook";
import type {
  AnalyzerResult,
  HostToWebview,
  WebviewState,
  WebviewToHost,
} from "./protocol";

interface CacheEntry {
  stamp: number;
  result: AnalyzerResult;
  source?: NotebookSource;
}

type BoundSource =
  | { kind: "file"; document: vscode.TextDocument }
  | { kind: "notebook"; notebook: vscode.NotebookDocument };

export class CallGraphController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelReady = false;
  private panelDisposables: vscode.Disposable[] = [];
  private bound: BoundSource | undefined;
  private lastResult: AnalyzerResult | undefined;
  private lastSource: NotebookSource | undefined;
  private currentState: WebviewState | undefined;
  private analysisGeneration = 0;
  private analysisAbort: AbortController | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private cursorTimer: NodeJS.Timeout | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly output = vscode.window.createOutputChannel("PyCallMap");

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show(): Promise<void> {
    const notebookEditor = vscode.window.activeNotebookEditor;
    if (notebookEditor) {
      this.ensurePanel();
      this.panel?.reveal(undefined, true);
      this.bindNotebook(notebookEditor.notebook);
      await this.refresh(true);
      return;
    }
    const tabNotebook = await this.notebookFromActiveTab();
    if (tabNotebook) {
      this.ensurePanel();
      this.panel?.reveal(undefined, true);
      this.bindNotebook(tabNotebook);
      await this.refresh(true);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage(
        "Open a Python file or notebook first."
      );
      return;
    }
    this.ensurePanel();
    this.panel?.reveal(undefined, true);
    if (editor.document.languageId !== "python") {
      this.postState({ kind: "notPython" });
      return;
    }
    this.bindDocument(editor.document);
    await this.refresh(true);
  }

  // The command palette can steal focus from a notebook editor, leaving
  // activeNotebookEditor undefined while a notebook tab is still active.
  private async notebookFromActiveTab(): Promise<
    vscode.NotebookDocument | undefined
  > {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputNotebook)) {
      return undefined;
    }
    try {
      return await vscode.workspace.openNotebookDocument(input.uri);
    } catch {
      return undefined;
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
        this.panelReady = false;
        this.disposeListeners();
      }),
      this.panel.webview.onDidReceiveMessage((message: WebviewToHost) => {
        void this.onMessage(message);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChanged(event)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveEditorChanged(editor)),
      vscode.workspace.onDidSaveTextDocument((document) => this.onSaved(document)),
      vscode.window.onDidChangeNotebookEditorSelection((event) =>
        this.onNotebookSelectionChanged(event)
      ),
      vscode.window.onDidChangeActiveNotebookEditor((editor) =>
        this.onActiveNotebookEditorChanged(editor)
      ),
      vscode.workspace.onDidChangeNotebookDocument((event) =>
        this.onNotebookChanged(event)
      ),
      vscode.workspace.onDidCloseNotebookDocument((notebook) =>
        this.onNotebookClosed(notebook)
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pyCallMap")) {
          this.cache.clear();
          if (this.bound) {
            void this.refresh(true);
          }
        }
      })
    );
  }

  private invalidateAnalysis(): void {
    this.analysisGeneration += 1;
    this.analysisAbort?.abort();
    this.analysisAbort = undefined;
  }

  private bindDocument(document: vscode.TextDocument): void {
    if (this.boundUri()?.toString() !== document.uri.toString()) {
      this.invalidateAnalysis();
      this.lastResult = undefined;
      this.lastSource = undefined;
      this.currentState = undefined;
    }
    this.bound = { kind: "file", document };
  }

  private bindNotebook(notebook: vscode.NotebookDocument): void {
    const boundNotebook =
      this.bound?.kind === "notebook" ? this.bound.notebook : undefined;
    if (boundNotebook !== notebook) {
      this.invalidateAnalysis();
      this.lastResult = undefined;
      this.lastSource = undefined;
      this.currentState = undefined;
      if (boundNotebook?.uri.toString() === notebook.uri.toString()) {
        this.cache.delete(notebook.uri.toString());
      }
    }
    this.bound = { kind: "notebook", notebook };
  }

  private boundUri(): vscode.Uri | undefined {
    if (!this.bound) {
      return undefined;
    }
    return this.bound.kind === "file"
      ? this.bound.document.uri
      : this.bound.notebook.uri;
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

  private renderResult(
    result: AnalyzerResult,
    source?: NotebookSource
  ): void {
    this.lastSource = source;
    const errorDiagnostic = result.diagnostics.find((item) => item.severity === "error");
    if (errorDiagnostic) {
      this.lastResult = undefined;
      this.lastSource = undefined;
      let detail =
        errorDiagnostic.line > 0
          ? `Line ${errorDiagnostic.line}: ${errorDiagnostic.message}`
          : errorDiagnostic.message;
      let title = errorDiagnostic.line > 0 ? "Syntax error" : "Analysis failed";
      if (source && errorDiagnostic.line > 0) {
        const position = concatLineToCell(source, errorDiagnostic.line);
        const range = position
          ? source.ranges.find((item) => item.cellIndex === position.cellIndex)
          : undefined;
        if (position && range) {
          detail = `Cell ${range.codeNumber}: ${errorDiagnostic.message}`;
          title = "Syntax error";
        }
      }
      this.postState({ kind: "error", title, detail, canOpenSettings: false });
      return;
    }
    if (result.functions.length === 0) {
      this.lastResult = undefined;
      this.lastSource = undefined;
      this.postState({ kind: "empty" });
      return;
    }
    this.lastResult = result;
    this.postGraph(result);
  }

  private async refresh(force: boolean): Promise<void> {
    if (!this.panel || !this.bound) {
      return;
    }
    const bound = this.bound;
    if (bound.kind === "file" && bound.document.languageId !== "python") {
      this.postState({ kind: "notPython" });
      return;
    }
    // Security gate: an untrusted workspace must never be able to choose the
    // executable that runs the analyzer (via pyCallMap.pythonPath or a .venv),
    // so refuse to spawn it and surface an error before any candidate resolution.
    if (!vscode.workspace.isTrusted) {
      this.lastResult = undefined;
      this.postState({
        kind: "error",
        title: "Workspace not trusted",
        detail:
          "PyCallMap requires a trusted workspace to run its analyzer. Open this folder in a trusted window to view the call graph.",
        canOpenSettings: false,
      });
      return;
    }
    if (bound.kind === "notebook") {
      await this.refreshNotebook(bound.notebook, force);
      return;
    }
    const document = bound.document;
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
    if (!force && cached && cached.stamp === mtimeMs) {
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
      this.cache.set(cacheKey, { stamp: mtimeMs, result });
      this.trimCache();
      this.renderResult(result);
    } catch (error) {
      if (generation !== this.analysisGeneration || abortController.signal.aborted) {
        return;
      }
      this.reportAnalysisError(error);
    }
  }

  private async refreshNotebook(
    notebook: vscode.NotebookDocument,
    force: boolean
  ): Promise<void> {
    const cacheKey = notebook.uri.toString();
    const stamp = notebook.version;
    const cached = this.cache.get(cacheKey);
    if (!force && cached && cached.stamp === stamp) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      this.renderResult(cached.result, cached.source);
      return;
    }
    const cells = notebook
      .getCells()
      .map((cell, index) => ({ cell, index }))
      .filter((item) => item.cell.kind === vscode.NotebookCellKind.Code)
      .map((item) => ({ index: item.index, text: item.cell.document.getText() }));
    const generation = ++this.analysisGeneration;
    this.analysisAbort?.abort();
    const abortController = new AbortController();
    this.analysisAbort = abortController;
    this.postState({ kind: "loading" });
    try {
      const analysis = await analyzeNotebook(
        cells,
        notebook.uri.fsPath,
        {
          platform: process.platform,
          pathExists: (candidate) => fs.existsSync(candidate),
          workspaceFolder: vscode.workspace.getWorkspaceFolder(notebook.uri)?.uri
            .fsPath,
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
      this.cache.set(cacheKey, {
        stamp,
        result: analysis.result,
        source: analysis.source,
      });
      this.trimCache();
      this.renderResult(analysis.result, analysis.source);
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
    this.lastSource = undefined;
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
    const bound = this.bound;
    if (!this.panel || !bound || bound.kind !== "file") {
      return;
    }
    if (document.uri.toString() !== bound.document.uri.toString()) {
      return;
    }
    if (
      !vscode.workspace
        .getConfiguration("pyCallMap")
        .get<boolean>("autoRefreshOnSave", true)
    ) {
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
    const bound = this.bound;
    if (
      bound &&
      bound.kind === "file" &&
      editor.document.uri.toString() === bound.document.uri.toString()
    ) {
      if (this.lastResult) {
        this.postGraph(this.lastResult);
      }
      return;
    }
    this.bindDocument(editor.document);
    void this.refresh(false);
  }

  private onSelectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    const bound = this.bound;
    if (!this.panel || !bound || bound.kind !== "file") {
      return;
    }
    if (event.textEditor.document.uri.toString() !== bound.document.uri.toString()) {
      return;
    }
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
    }
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      const bound = this.bound;
      if (
        !bound ||
        bound.kind !== "file" ||
        bound.document.uri.toString() !== event.textEditor.document.uri.toString()
      ) {
        return;
      }
      const line = event.selections[0]?.active.line ?? 0;
      this.post({ type: "cursor", line: line + 1 });
    }, 100);
  }

  private onNotebookSelectionChanged(
    event: vscode.NotebookEditorSelectionChangeEvent
  ): void {
    const bound = this.bound;
    if (!this.panel || !bound || bound.kind !== "notebook") {
      return;
    }
    if (
      event.notebookEditor.notebook.uri.toString() !==
      bound.notebook.uri.toString()
    ) {
      return;
    }
    const cellIndex = event.selections[0]?.start ?? -1;
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
    }
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = undefined;
      const bound = this.bound;
      if (
        !bound ||
        bound.kind !== "notebook" ||
        bound.notebook.uri.toString() !==
          event.notebookEditor.notebook.uri.toString()
      ) {
        return;
      }
      const range =
        cellIndex >= 0 && this.lastSource
          ? cellRangeFor(this.lastSource, cellIndex)
          : undefined;
      if (range) {
        this.post({ type: "cursor", line: range.line, endLine: range.endLine });
      } else {
        this.post({ type: "cursor", line: 0 });
      }
    }, 100);
  }

  private onNotebookChanged(event: vscode.NotebookDocumentChangeEvent): void {
    const bound = this.bound;
    if (!this.panel || !bound || bound.kind !== "notebook") {
      return;
    }
    if (event.notebook.uri.toString() !== bound.notebook.uri.toString()) {
      return;
    }
    const contentChanged =
      event.contentChanges.length > 0 ||
      event.cellChanges.some((change) => change.document !== undefined);
    if (!contentChanged) {
      return;
    }
    this.scheduleRefresh();
  }

  private onNotebookClosed(notebook: vscode.NotebookDocument): void {
    const bound = this.bound;
    if (!bound || bound.kind !== "notebook" || bound.notebook !== notebook) {
      return;
    }
    this.invalidateAnalysis();
    this.bound = undefined;
    this.lastResult = undefined;
    this.lastSource = undefined;
    this.currentState = undefined;
    this.cache.delete(notebook.uri.toString());
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = undefined;
    }
  }

  private onActiveNotebookEditorChanged(
    editor: vscode.NotebookEditor | undefined
  ): void {
    if (!this.panel || !editor) {
      return;
    }
    const notebook = editor.notebook;
    const bound = this.bound;
    if (bound && bound.kind === "notebook" && bound.notebook === notebook) {
      if (this.lastResult) {
        this.postGraph(this.lastResult);
      }
      return;
    }
    this.bindNotebook(notebook);
    void this.refresh(false);
  }

  private async jump(line1Based: number): Promise<void> {
    const bound = this.bound;
    if (!bound) {
      return;
    }
    if (bound.kind === "notebook") {
      const position = this.lastSource
        ? concatLineToCell(this.lastSource, line1Based)
        : undefined;
      if (!position) {
        return;
      }
      const range = new vscode.NotebookRange(
        position.cellIndex,
        position.cellIndex + 1
      );
      const notebook = bound.notebook.isClosed
        ? await vscode.workspace.openNotebookDocument(bound.notebook.uri)
        : bound.notebook;
      const editor = await vscode.window.showNotebookDocument(notebook, {
        selections: [range],
        preserveFocus: false,
      });
      editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
      return;
    }
    const document = bound.document;
    const visibleEditor = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === document.uri.toString()
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
