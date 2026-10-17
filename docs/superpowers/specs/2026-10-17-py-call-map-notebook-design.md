# PyCallMap Notebook (.ipynb) Support — Design

**Date:** 2026-10-17
**Status:** Approved for planning
**Extends:** `2026-10-17-py-call-map-design.md` (v0.1.0, single Python file)

## Goal

Let PyCallMap render one call graph for a Jupyter notebook (`.ipynb`) by treating every
code cell as part of a single Python program, in document order. Cross-cell calls
(a function defined in one cell and called in another) must appear as edges.

## Non-goals

- Per-cell graphs. One notebook produces exactly one graph.
- Execution-order analysis (`execution_count`). Document order is used.
- Markdown/raw cells, outputs, or notebook metadata.
- Cross-notebook or cross-file analysis (unchanged from 0.1.0).
- Python version detection or kernel interaction. Notebook analysis never executes code
  and never talks to a kernel.

## Architecture

Two units, one of which is new:

### `src/notebook.ts` (new, pure, no `vscode` import)

```ts
export interface NotebookCellSource {
  index: number; // index in notebook.getCells()
  text: string;
}

export interface CellRange {
  cellIndex: number;   // index in notebook.getCells()
  codeNumber: number;  // 1-based ordinal among code cells, used for display
  startLine: number;   // 1-based line in the concatenated source
  lineCount: number;   // number of lines this cell contributed
}

export interface NotebookSource {
  text: string;
  ranges: CellRange[];
  skippedCells: number[]; // cell indices skipped because of a %% cell magic
}

export function buildNotebookSource(cells: NotebookCellSource[]): NotebookSource;

export interface CellPosition {
  cellIndex: number;
  line: number; // 1-based line inside the cell's source
}

export function concatLineToCell(source: NotebookSource, line: number): CellPosition | undefined;
```

Rules:

1. Cells are concatenated in the order given (the caller passes code cells in document order).
2. A cell whose first non-blank, non-comment line starts with `%%` is skipped entirely:
   it contributes no lines, appears in `skippedCells`, and has no `CellRange`.
3. A line whose first non-whitespace characters are `%`, `!`, or `?` is replaced by
   `<original indentation>pass`. Line count and position are preserved.
4. Every other line is copied verbatim.
5. Cell text is normalised by dropping one trailing `\n` and splitting on `\n`. A cell
   whose normalised lines are all empty contributes no lines and no `CellRange`.
   Otherwise it contributes exactly `lines.length` lines, each followed by `\n`, so two
   cells are never merged onto one line and `lineCount` is exact.
6. `concatLineToCell` returns the cell containing a 1-based concatenated line, or
   `undefined` for out-of-range lines.

### `src/controller.ts` (modified)

The controller gains a bound-source union:

```ts
type BoundSource =
  | { kind: "file"; document: vscode.TextDocument }
  | { kind: "notebook"; notebook: vscode.NotebookDocument };
```

- `show()` checks `vscode.window.activeNotebookEditor` first, then `activeTextEditor`.
- Notebook analysis:
  1. Collect cells where `cell.kind === vscode.NotebookCellKind.Code`, in document order.
  2. `buildNotebookSource` over `cell.document.getText()`.
  3. If the source has no lines (every cell skipped or empty), post the existing `empty` state.
  4. Write the concatenated text to a temp file (`os.tmpdir()`, UTF-8, unique name) and call
     the existing `analyzeFile`.
  5. Delete the temp file in `finally`.
- The webview keeps receiving a continuous numeric line space (the concatenated line
  numbers). No webview-side change is required for mapping.
- Jump: the webview's `jump` message carries a concatenated line; the controller maps it
  through `concatLineToCell` and reveals the notebook cell (`showNotebookDocument` with a
  `NotebookRange` selecting the cell, then `revealRange(..., InCenter)`).
- Cursor highlight: the stable VSCode API exposes notebook selections only at cell
  granularity, not an intra-cell cursor line. The controller therefore subscribes to
  `vscode.window.onDidChangeNotebookEditorSelection` and, for the active cell, posts that
  cell's whole concatenated range. `HostToWebview`'s cursor message gains an optional
  `endLine`; when present the webview highlights every node whose `[line, endLine]`
  intersects `[line, endLine]`, and clears the highlight when no cell range is available.
  File analysis keeps sending `line` alone.
- Auto-refresh: subscribe to `vscode.workspace.onDidChangeNotebookDocument` with the
  existing 300 ms debounce. Notebooks auto-save, so `autoRefreshOnSave` does not apply.
- Cache: keyed by notebook URI, storing the notebook `version` alongside the result. A
  changed version forces a re-analysis. The file path keeps its mtime-based key.
- Workspace-trust gate, 5 s timeout, 10 MB cap, and abort/generation handling apply
  unchanged to notebook analysis.

### `src/protocol.ts` (modified)

Add optional display fields so tooltips need no synthetic line numbers:

- `FunctionNode.location?: string` — e.g. `"Cell 3 · line 12"`, where the cell number is
  `codeNumber` (the 1-based ordinal among code cells).
- `CallEdge.locations?: string[]` — one entry per call site.
- `HostToWebview`'s `{ type: "cursor" }` gains optional `endLine` (see below).

Both are populated only for notebooks; `parseAnalyzerOutput` ignores them (the analyzer
never emits them). `graph.ts` copies them into node/edge data, and `main.ts` prefers them
over `lines …` in the tooltip.

### `package.json` (modified)

- Add a `notebook/toolbar` menu entry for `pyCallMap.show` with
  `"when": "notebookType == jupyter-notebook"`, group `navigation`, icon `$(graph)`.
- Keep the existing `editor/title` entry for Python text files. The command has no
  `menus.commandPalette` restriction, so it stays reachable from the palette for notebooks.

## Error handling

- A syntax error is mapped back to its cell before display. The state stays
  `{ kind: "error", title: "Syntax error", detail: "Cell N: <message>" }`; a line that
  cannot be mapped keeps the raw message.
- Analyzer failures, missing interpreter, untrusted workspace, and file-unavailable
  states are unchanged.
- A notebook that produces no functions posts `empty`.
- Temp-file write/delete failures surface through the existing `Analysis failed` path.

## Testing

`test/ts/notebook.test.ts` (new, Vitest, pure):

1. Concatenates cells in order with one `\n` per cell and correct `ranges`.
2. `concatLineToCell` maps the first and last line of each cell; out-of-range → undefined.
3. Line magics (`%`, `!`, `?`) become `pass` with indentation preserved, line count unchanged.
4. A `%%` cell is skipped, excluded from `ranges`, recorded in `skippedCells`, and does not
   shift later mappings.
5. Empty cells contribute no range and do not break mapping of neighbours.
6. Comments and blank lines inside a non-empty cell are copied verbatim.

`test/ts/integration.test.ts` (extend):

8. Two code cells — one defines a function, the other calls it — are combined via
   `buildNotebookSource`, written to a temp `.py`, and analyzed with the real interpreter;
   the cross-cell edge exists and both function line numbers map to the expected cells.

`test/python/test_analyze.py` is unchanged: the analyzer contract does not change.

## Limitations (documented in README)

- Document order only; `execution_count` is ignored.
- Cells starting with `%%` are skipped entirely.
- Magic lines are neutralised, so code inside them is not analyzed.
- Cross-cell variable state and types are not inferred (same as single-file analysis).
- The graph covers code cells only; markdown and outputs are ignored.

## Versioning

Bump to `0.2.0`; add a CHANGELOG entry. `0.1.0` can be published unchanged before this
work lands.
