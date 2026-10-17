# PyCallMap Notebook (.ipynb) Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render one call graph for all Python code cells of a Jupyter notebook, with cross-cell edges, cell-aware tooltips, click-to-cell jump, and cell-range cursor highlighting.

**Architecture:** A pure module concatenates code cells into one Python source and keeps an exact line→cell map; a small bridge writes that source to a temp file and reuses the existing analyzer; the controller gains a file/notebook bound-source union; the webview gains optional location strings and range-based cursor highlighting. No notebook code is ever executed.

**Tech Stack:** TypeScript (strict, node16 modules), VSCode Extension API ~1.85, Cytoscape.js + dagre, Vitest, Python 3 stdlib analyzer (`python/analyze.py`).

## Global Constraints

- Extension version becomes `0.2.0`; `CHANGELOG.md` gets a `0.2.0` entry.
- No new runtime or dev dependencies.
- Analyzer contract and `python/analyze.py` do not change; `AnalyzerResult.version` stays `1`.
- New protocol fields are optional: `FunctionNode.location?: string`, `CallEdge.locations?: string[]`, `HostToWebview` cursor `endLine?: number`.
- `src/notebook.ts` must not import `vscode` (pure, unit-testable under Node). It may import only types from `./protocol`.
- Notebook analysis never executes cell code and never contacts a kernel. It writes a single UTF-8 `.py` file under `os.tmpdir()` and deletes it in `finally`.
- Analyzer line numbers are 1-based; no conversion. Diagnostics' `column` stays 0-based and is not displayed.
- Workspace-trust gate, 5 s timeout, 10 MB output cap, and abort/generation handling apply to notebooks exactly as to files.
- All pre-existing tests must keep passing: `npm test` (Vitest) and `python -m unittest discover -s test/python -p "test_*.py" -v`.
- Commit after each task with a conventional message (`feat:`, `test:`, `docs:`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/notebook.ts` (new) | Pure: cell concatenation, line↔cell mapping, location strings, cell ranges. No VSCode import. |
| `src/notebookAnalysis.ts` (new) | Temp-file bridge: `buildNotebookSource` → write temp `.py` → `analyzeFile` → `applyLocations` → cleanup. |
| `test/ts/notebook.test.ts` (new) | Pure unit tests for `src/notebook.ts`. |
| `test/ts/integration.test.ts` (extend) | Real-interpreter test of `analyzeNotebook` (cross-cell edge, locations, cleanup) plus an empty-notebook no-spawn test. |
| `src/protocol.ts` (modify) | Optional `location` / `locations` / `endLine` fields. |
| `src/webview/graph.ts` (modify) | Copy location fields into cytoscape element data. |
| `src/webview/main.ts` (modify) | Prefer location strings in tooltips; range-based cursor highlight. |
| `test/ts/graph.test.ts` (extend) | Assert location fields survive `buildElements`. |
| `src/controller.ts` (modify) | Bound-source union, notebook analysis/cache, jump, cell-range cursor, notebook change refresh. |
| `package.json` (modify) | `notebook/toolbar` menu, version `0.2.0`. |
| `CHANGELOG.md`, `README.md` (modify) | Document notebook support and limitations. |
| `examples/demo.ipynb` (new) | Manual smoke-test notebook (markdown + two code cells). |

Tasks 1–3 are independently testable. Task 4 is the integration task and ends with the full verification suite.

---

### Task 1: Notebook source builder

**Files:**
- Create: `src/notebook.ts`
- Modify: `src/protocol.ts` (add the two optional location fields; the cursor field is Task 3)
- Test: `test/ts/notebook.test.ts`

**Interfaces:**
- Consumes: `AnalyzerResult` from `./protocol` (type-only).
- Produces:
  - `buildNotebookSource(cells: NotebookCellSource[]): NotebookSource`
  - `concatLineToCell(source: NotebookSource, line: number): CellPosition | undefined`
  - `cellRangeFor(source: NotebookSource, cellIndex: number): { line: number; endLine: number } | undefined`
  - `lineLocation(source: NotebookSource, line: number): string | undefined`
  - `applyLocations(result: AnalyzerResult, source: NotebookSource): AnalyzerResult`
  - Types: `NotebookCellSource { index; text }`, `CellRange { cellIndex; codeNumber; startLine; lineCount }`, `NotebookSource { text; ranges; skippedCells }`, `CellPosition { cellIndex; line }`.

- [ ] **Step 1: Write the failing tests**

Create `test/ts/notebook.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AnalyzerResult } from "../../src/protocol";
import {
  applyLocations,
  buildNotebookSource,
  cellRangeFor,
  concatLineToCell,
  lineLocation,
  type NotebookCellSource,
} from "../../src/notebook";

function cells(texts: string[]): NotebookCellSource[] {
  return texts.map((text, index) => ({ index, text }));
}

describe("buildNotebookSource", () => {
  it("concatenates cells in document order with exact ranges", () => {
    const source = buildNotebookSource(cells(["def a():\n    pass", "a()"]));
    expect(source.text).toBe("def a():\n    pass\na()\n");
    expect(source.ranges).toEqual([
      { cellIndex: 0, codeNumber: 1, startLine: 1, lineCount: 2 },
      { cellIndex: 1, codeNumber: 2, startLine: 3, lineCount: 1 },
    ]);
    expect(source.skippedCells).toEqual([]);
  });

  it("neutralises line magics while preserving indentation and line count", () => {
    const source = buildNotebookSource(
      cells(["%matplotlib inline\nif flag:\n    !pip install x\n?len"])
    );
    expect(source.text).toBe("pass\nif flag:\n    pass\npass\n");
    expect(source.ranges[0]).toEqual({
      cellIndex: 0,
      codeNumber: 1,
      startLine: 1,
      lineCount: 4,
    });
  });

  it("skips %% cells without shifting later ranges", () => {
    const source = buildNotebookSource(cells(["%%bash\necho hi", "x = 1"]));
    expect(source.text).toBe("x = 1\n");
    expect(source.skippedCells).toEqual([0]);
    expect(source.ranges).toEqual([
      { cellIndex: 1, codeNumber: 2, startLine: 1, lineCount: 1 },
    ]);
    expect(concatLineToCell(source, 1)).toEqual({ cellIndex: 1, line: 1 });
  });

  it("ignores empty cells and keeps neighbour mappings intact", () => {
    const source = buildNotebookSource(cells(["", "   ", "x = 1"]));
    expect(source.text).toBe("x = 1\n");
    expect(source.ranges).toEqual([
      { cellIndex: 2, codeNumber: 3, startLine: 1, lineCount: 1 },
    ]);
    expect(concatLineToCell(source, 1)).toEqual({ cellIndex: 2, line: 1 });
  });

  it("copies comments and blank lines verbatim", () => {
    const source = buildNotebookSource(cells(["# note\n\ndef f():\n    pass"]));
    expect(source.text).toBe("# note\n\ndef f():\n    pass\n");
  });
});

describe("concatLineToCell", () => {
  it("maps the first and last line of each cell and rejects out-of-range lines", () => {
    const source = buildNotebookSource(cells(["a = 1\nb = 2\nc = 3", "d = 4"]));
    expect(concatLineToCell(source, 1)).toEqual({ cellIndex: 0, line: 1 });
    expect(concatLineToCell(source, 3)).toEqual({ cellIndex: 0, line: 3 });
    expect(concatLineToCell(source, 4)).toEqual({ cellIndex: 1, line: 1 });
    expect(concatLineToCell(source, 0)).toBeUndefined();
    expect(concatLineToCell(source, 5)).toBeUndefined();
  });
});

describe("cellRangeFor", () => {
  it("returns a cell's whole concatenated range", () => {
    const source = buildNotebookSource(cells(["a = 1\nb = 2", "c = 3"]));
    expect(cellRangeFor(source, 0)).toEqual({ line: 1, endLine: 2 });
    expect(cellRangeFor(source, 1)).toEqual({ line: 3, endLine: 3 });
    expect(cellRangeFor(source, 2)).toBeUndefined();
  });
});

describe("applyLocations", () => {
  it("labels functions and call sites with cell and line numbers", () => {
    const source = buildNotebookSource(cells(["def a():\n    pass", "a()"]));
    const result: AnalyzerResult = {
      version: 1,
      file: "notebook.ipynb",
      functions: [
        {
          id: "a",
          name: "a",
          signature: "a()",
          kind: "function",
          owner: null,
          parent: null,
          line: 1,
          endLine: 2,
          entry: false,
          unused: true,
          externalCalls: 0,
        },
      ],
      edges: [
        { id: "e1", source: "a", target: "a", lines: [3, 99], cyclic: true },
      ],
      diagnostics: [],
      stats: { functionCount: 1, edgeCount: 1, parsedInMs: 0 },
    };

    const located = applyLocations(result, source);
    expect(located.functions[0].location).toBe("Cell 1 · line 1");
    expect(located.edges[0].locations).toEqual(["Cell 2 · line 1"]);
    expect(lineLocation(source, 3)).toBe("Cell 2 · line 1");
    expect(lineLocation(source, 99)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ts/notebook.test.ts`
Expected: FAIL — cannot resolve `../../src/notebook`.

- [ ] **Step 3: Implement `src/notebook.ts`**

```ts
import type { AnalyzerResult } from "./protocol";

export interface NotebookCellSource {
  index: number;
  text: string;
}

export interface CellRange {
  cellIndex: number;
  codeNumber: number;
  startLine: number;
  lineCount: number;
}

export interface NotebookSource {
  text: string;
  ranges: CellRange[];
  skippedCells: number[];
}

export interface CellPosition {
  cellIndex: number;
  line: number;
}

const CELL_MAGIC = /^\s*%%/;
const LINE_MAGIC = /^(\s*)[%!?]/;

function normalizedLines(text: string): string[] {
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailingNewline.split("\n");
}

function isBlank(lines: string[]): boolean {
  return lines.every((line) => line.trim() === "");
}

function startsWithCellMagic(lines: string[]): boolean {
  const firstRealLine = lines.find((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
  return firstRealLine !== undefined && CELL_MAGIC.test(firstRealLine);
}

export function buildNotebookSource(cells: NotebookCellSource[]): NotebookSource {
  const lines: string[] = [];
  const ranges: CellRange[] = [];
  const skippedCells: number[] = [];
  let codeNumber = 0;
  for (const cell of cells) {
    codeNumber += 1;
    const cellLines = normalizedLines(cell.text);
    if (startsWithCellMagic(cellLines)) {
      skippedCells.push(cell.index);
      continue;
    }
    if (isBlank(cellLines)) {
      continue;
    }
    ranges.push({
      cellIndex: cell.index,
      codeNumber,
      startLine: lines.length + 1,
      lineCount: cellLines.length,
    });
    for (const line of cellLines) {
      const magic = LINE_MAGIC.exec(line);
      lines.push(magic ? `${magic[1]}pass` : line);
    }
  }
  return {
    text: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    ranges,
    skippedCells,
  };
}

export function concatLineToCell(
  source: NotebookSource,
  line: number
): CellPosition | undefined {
  for (const range of source.ranges) {
    if (line >= range.startLine && line < range.startLine + range.lineCount) {
      return { cellIndex: range.cellIndex, line: line - range.startLine + 1 };
    }
  }
  return undefined;
}

export function cellRangeFor(
  source: NotebookSource,
  cellIndex: number
): { line: number; endLine: number } | undefined {
  const range = source.ranges.find((item) => item.cellIndex === cellIndex);
  if (!range) {
    return undefined;
  }
  return { line: range.startLine, endLine: range.startLine + range.lineCount - 1 };
}

export function lineLocation(
  source: NotebookSource,
  line: number
): string | undefined {
  const position = concatLineToCell(source, line);
  if (!position) {
    return undefined;
  }
  const range = source.ranges.find((item) => item.cellIndex === position.cellIndex);
  return range ? `Cell ${range.codeNumber} · line ${position.line}` : undefined;
}

export function applyLocations(
  result: AnalyzerResult,
  source: NotebookSource
): AnalyzerResult {
  return {
    ...result,
    functions: result.functions.map((fn) => {
      const location = lineLocation(source, fn.line);
      return location ? { ...fn, location } : fn;
    }),
    edges: result.edges.map((edge) => {
      const locations = edge.lines
        .map((line) => lineLocation(source, line))
        .filter((value): value is string => value !== undefined);
      return locations.length > 0 ? { ...edge, locations } : edge;
    }),
  };
}
```

Note: `FunctionNode.location` and `CallEdge.locations` are added to `src/protocol.ts` in Task 3. To keep Task 1 self-contained and compiling, add those two optional fields to `src/protocol.ts` **in this step** (they are additive and harmless):

```ts
// in FunctionNode, after externalCalls
  location?: string;
// in CallEdge, after cyclic
  locations?: string[];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ts/notebook.test.ts`
Expected: PASS — 8 tests passed.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/notebook.ts src/protocol.ts test/ts/notebook.test.ts
git commit -m "feat: add notebook source builder with line-to-cell mapping"
```

---

### Task 2: Notebook analysis bridge

**Files:**
- Create: `src/notebookAnalysis.ts`
- Test: `test/ts/integration.test.ts` (extend)

**Interfaces:**
- Consumes: `buildNotebookSource`, `applyLocations`, `NotebookCellSource`, `NotebookSource` from `./notebook`; `analyzeFile`, `BridgeEnvironment`, `RunDeps` from `./pythonBridge`; `AnalyzerResult` from `./protocol`.
- Produces:
  - `interface NotebookAnalysis { result: AnalyzerResult; source: NotebookSource }`
  - `analyzeNotebook(cells: NotebookCellSource[], notebookPath: string, env: BridgeEnvironment, scriptPath: string, deps: RunDeps): Promise<NotebookAnalysis>`

Behavior: `notebookPath` is the display path written into `result.file` (the real `.ipynb` URI path, supplied by the controller). An all-empty/skipped notebook returns an empty result immediately without spawning Python. Otherwise a unique temp directory + `notebook.py` is created, analyzed, and removed in `finally`.

- [ ] **Step 1: Write the failing tests**

Append to `test/ts/integration.test.ts`. First update the imports at the top of the file:

```ts
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeNotebook } from "../../src/notebookAnalysis";
import { parseAnalyzerOutput } from "../../src/pythonBridge";
```

Then add these inside the existing `describe.skipIf(python === undefined)("analyzer integration", ...)` block, after the current `it`:

```ts
  it("builds one graph across cells and maps lines back to cells", async () => {
    const interpreter = python as string;
    const scriptPath = path.resolve(process.cwd(), "python", "analyze.py");
    const analyzedPaths: string[] = [];
    const recordingSpawn = ((
      command: string,
      args: string[],
      options: Parameters<typeof spawn>[2]
    ) => {
      const fileIndex = args.indexOf("--file");
      if (fileIndex >= 0) {
        analyzedPaths.push(String(args[fileIndex + 1]));
      }
      return spawn(command, args, options);
    }) as unknown as typeof spawn;

    const analysis = await analyzeNotebook(
      [
        { index: 0, text: "def greet():\n    return 1" },
        { index: 2, text: "def main():\n    greet()" },
      ],
      path.join(os.tmpdir(), "demo.ipynb"),
      {
        platform: process.platform,
        pathExists: () => true,
        workspaceFolder: undefined,
        pythonPathSetting: interpreter,
      },
      scriptPath,
      { spawn: recordingSpawn, timeoutMs: 5000, maxOutputBytes: 10 * 1024 * 1024 }
    );

    expect(analysis.source.ranges).toEqual([
      { cellIndex: 0, codeNumber: 1, startLine: 1, lineCount: 2 },
      { cellIndex: 2, codeNumber: 2, startLine: 3, lineCount: 2 },
    ]);
    expect(analysis.source.skippedCells).toEqual([]);

    const greet = analysis.result.functions.find((fn) => fn.id === "greet");
    const main = analysis.result.functions.find((fn) => fn.id === "main");
    expect(greet?.location).toBe("Cell 1 · line 1");
    expect(main?.location).toBe("Cell 2 · line 1");

    const edge = analysis.result.edges.find(
      (item) => item.source === "main" && item.target === "greet"
    );
    expect(edge?.locations).toEqual(["Cell 2 · line 2"]);

    expect(analysis.result.file).toBe(path.join(os.tmpdir(), "demo.ipynb"));
    expect(analyzedPaths).toHaveLength(1);
    expect(fs.existsSync(analyzedPaths[0])).toBe(false);
  });
```

Then add a separate top-level block after the `describe.skipIf(...)` block:

```ts
describe("analyzeNotebook", () => {
  it("returns an empty result without spawning for an empty notebook", async () => {
    let spawned = false;
    const analysis = await analyzeNotebook(
      [{ index: 0, text: "\n\n" }],
      "/work/empty.ipynb",
      {
        platform: process.platform,
        pathExists: () => true,
        workspaceFolder: undefined,
        pythonPathSetting: "",
      },
      "unused-analyze.py",
      {
        spawn: (() => {
          spawned = true;
          throw new Error("must not spawn");
        }) as unknown as typeof spawn,
      }
    );

    expect(spawned).toBe(false);
    expect(analysis.result.functions).toEqual([]);
    expect(analysis.result.edges).toEqual([]);
    expect(analysis.result.diagnostics).toEqual([]);
    expect(analysis.result.file).toBe("/work/empty.ipynb");
    expect(analysis.source.text).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/ts/integration.test.ts`
Expected: FAIL — cannot resolve `../../src/notebookAnalysis`.

- [ ] **Step 3: Implement `src/notebookAnalysis.ts`**

```ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyLocations,
  buildNotebookSource,
  type NotebookCellSource,
  type NotebookSource,
} from "./notebook";
import type { AnalyzerResult } from "./protocol";
import {
  analyzeFile,
  type BridgeEnvironment,
  type RunDeps,
} from "./pythonBridge";

export interface NotebookAnalysis {
  result: AnalyzerResult;
  source: NotebookSource;
}

function emptyResult(file: string): AnalyzerResult {
  return {
    version: 1,
    file,
    functions: [],
    edges: [],
    diagnostics: [],
    stats: { functionCount: 0, edgeCount: 0, parsedInMs: 0 },
  };
}

export async function analyzeNotebook(
  cells: NotebookCellSource[],
  notebookPath: string,
  env: BridgeEnvironment,
  scriptPath: string,
  deps: RunDeps
): Promise<NotebookAnalysis> {
  const source = buildNotebookSource(cells);
  if (source.text.length === 0) {
    return { result: emptyResult(notebookPath), source };
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pycallmap-"));
  const filePath = path.join(directory, "notebook.py");
  try {
    await fs.writeFile(filePath, source.text, "utf8");
    const analyzed = await analyzeFile(filePath, env, scriptPath, deps);
    return {
      result: applyLocations({ ...analyzed, file: notebookPath }, source),
      source,
    };
  } finally {
    await fs
      .rm(directory, { recursive: true, force: true })
      .catch(() => undefined);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ts/integration.test.ts`
Expected: PASS — 2 tests passed (the real-interpreter tests are skipped only when no Python is on PATH; this machine has Python).

- [ ] **Step 5: Run the pure tests and typecheck, then commit**

```bash
npx vitest run test/ts/notebook.test.ts
npm run typecheck
git add src/notebookAnalysis.ts test/ts/integration.test.ts
git commit -m "feat: analyze notebook cells through a temporary Python file"
```

---

### Task 3: Protocol and webview support

**Files:**
- Modify: `src/protocol.ts` (cursor `endLine`; the two location fields already exist from Task 1)
- Modify: `src/webview/graph.ts:3-22` (data interfaces) and `src/webview/graph.ts:91-115` (`buildElements`)
- Modify: `src/webview/main.ts:20-29` (State), `src/webview/main.ts:168-183` (tooltips), `src/webview/main.ts:220-232` (`updateCursor`), `src/webview/main.ts:311-315` (message handler)
- Test: `test/ts/graph.test.ts` (extend)

**Interfaces:**
- Consumes: `FunctionNode.location?: string`, `CallEdge.locations?: string[]` (Task 1).
- Produces: `GraphNodeData.location?: string`, `GraphEdgeData.locations?: string[]`; `HostToWebview` cursor message `{ type: "cursor"; line: number; endLine?: number }`. Range highlighting applies when `endLine` is present; file behavior (`line` only) is unchanged.

- [ ] **Step 1: Write the failing test**

In `test/ts/graph.test.ts`, update the `fn` helper to carry the optional field:

```ts
function fn(overrides: Partial<FunctionNode> & Pick<FunctionNode, "id">): FunctionNode {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    signature: overrides.signature ?? `${overrides.id}()`,
    kind: overrides.kind ?? "function",
    owner: overrides.owner ?? null,
    parent: overrides.parent ?? null,
    line: overrides.line ?? 1,
    endLine: overrides.endLine ?? 1,
    entry: overrides.entry ?? false,
    unused: overrides.unused ?? false,
    externalCalls: overrides.externalCalls ?? 0,
    location: overrides.location,
  };
}
```

Add this test inside the existing `describe("buildElements", ...)` block:

```ts
  it("copies notebook locations into node and edge data", () => {
    const result = sample();
    result.functions = result.functions.map((item) =>
      item.id === "main" ? { ...item, location: "Cell 2 · line 1" } : item
    );
    result.edges = result.edges.map((edge) =>
      edge.id === "e1" ? { ...edge, locations: ["Cell 2 · line 2"] } : edge
    );

    const elements = buildElements(result, false);
    const node = elements.find(
      (element) => "label" in element.data && element.data.id === "main"
    );
    expect(node && "label" in node.data ? node.data.location : undefined).toBe(
      "Cell 2 · line 1"
    );

    const edge = elements.find(
      (element) => "source" in element.data && element.data.id === "e1"
    );
    expect(
      edge && "locations" in edge.data ? edge.data.locations : undefined
    ).toEqual(["Cell 2 · line 2"]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ts/graph.test.ts`
Expected: FAIL — the `location`/`locations` assertions receive `undefined` because `buildElements` does not copy them.

- [ ] **Step 3: Add the cursor field to `src/protocol.ts`**

Change:

```ts
  | { type: "cursor"; line: number }
```

to:

```ts
  | { type: "cursor"; line: number; endLine?: number }
```

- [ ] **Step 4: Copy locations in `src/webview/graph.ts`**

Add to `GraphNodeData` after `externalCalls: number;`:

```ts
  location?: string;
```

Add to `GraphEdgeData` after `label: string;`:

```ts
  locations?: string[];
```

Add to the node data object in `buildElements` after `externalCalls: fn.externalCalls,`:

```ts
      location: fn.location,
```

Add to the edge data object after `label: edge.lines.length > 1 ? `×${edge.lines.length}` : "",`:

```ts
        locations: edge.locations,
```

- [ ] **Step 5: Update `src/webview/main.ts`**

Add `cursorEndLine?: number;` to `interface State` after `cursorLine?: number;`.

Replace the two tooltip handlers in `installHandlers()`:

```ts
  cy.on("mouseover", "node", (event) => {
    const data = event.target.data();
    const location =
      typeof data.location === "string"
        ? data.location
        : `lines ${data.line}-${data.endLine}`;
    showTooltip(
      `${data.signature}\n${location}\nexternal calls: ${data.externalCalls}`,
      event.renderedPosition
    );
  });
  cy.on("mouseout", "node", () => hideTooltip());
  cy.on("mouseover", "edge", (event) => {
    const data = event.target.data();
    const locations = data.locations as string[] | undefined;
    const where =
      locations && locations.length > 0
        ? locations.join(", ")
        : `lines ${(data.lines as number[]).join(", ")}`;
    showTooltip(
      `${data.source} → ${data.target}\n${where}`,
      event.renderedPosition
    );
  });
  cy.on("mouseout", "edge", () => hideTooltip());
```

Replace `updateCursor()` with:

```ts
function updateCursor(): void {
  if (!cy || !state.result) {
    return;
  }
  cy.nodes().removeClass("cursor");
  if (state.cursorLine === undefined) {
    return;
  }
  if (state.cursorEndLine === undefined) {
    const target = findFunctionAtLine(state.result.functions, state.cursorLine);
    if (target) {
      cy.getElementById(target.id).addClass("cursor");
    }
    return;
  }
  const start = state.cursorLine;
  const end = state.cursorEndLine;
  const candidates = state.result.functions.filter(
    (fn) => fn.line <= end && start <= fn.endLine
  );
  for (const fn of candidates) {
    const containsNested = candidates.some(
      (other) =>
        other !== fn &&
        fn.line <= other.line &&
        other.endLine <= fn.endLine &&
        other.endLine - other.line < fn.endLine - fn.line
    );
    if (!containsNested) {
      cy.getElementById(fn.id).addClass("cursor");
    }
  }
}
```

Replace the cursor branch of the message listener:

```ts
  if (message.type === "cursor") {
    state.cursorLine = message.line;
    state.cursorEndLine = message.endLine;
    updateCursor();
    return;
  }
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run test/ts/graph.test.ts`
Expected: PASS — 13 tests passed.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/protocol.ts src/webview/graph.ts src/webview/main.ts test/ts/graph.test.ts
git commit -m "feat: render notebook locations and cell-range cursor highlights"
```

---

### Task 4: Controller wiring, menu, and docs

**Files:**
- Modify: `src/controller.ts`
- Modify: `package.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Create: `examples/demo.ipynb`

**Interfaces:**
- Consumes: `analyzeNotebook` (Task 2), `concatLineToCell`, `cellRangeFor`, `NotebookSource` (Task 1), protocol cursor `endLine` (Task 3).
- Produces: a `notebook/toolbar` menu entry for `pyCallMap.show`; version `0.2.0`.

There are no controller unit tests (the project has none); this task is verified by typecheck, the full suite, the build, and the packaging step.

- [ ] **Step 1: Update imports and the cache type in `src/controller.ts`**

Replace the import block:

```ts
import { analyzeFile, AnalyzerError, PythonNotFoundError } from "./pythonBridge";
import { lineToIndex } from "./lineNumbers";
import type {
  AnalyzerResult,
  HostToWebview,
  WebviewState,
  WebviewToHost,
} from "./protocol";
```

with:

```ts
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
```

Replace the `CacheEntry` interface:

```ts
interface CacheEntry {
  mtimeMs: number;
  result: AnalyzerResult;
}
```

with:

```ts
interface CacheEntry {
  stamp: number;
  result: AnalyzerResult;
  source?: NotebookSource;
}

type BoundSource =
  | { kind: "file"; document: vscode.TextDocument }
  | { kind: "notebook"; notebook: vscode.NotebookDocument };
```

- [ ] **Step 2: Replace the bound fields**

Replace:

```ts
  private boundUri: vscode.Uri | undefined;
  private boundDocument: vscode.TextDocument | undefined;
  private lastResult: AnalyzerResult | undefined;
```

with:

```ts
  private bound: BoundSource | undefined;
  private lastResult: AnalyzerResult | undefined;
  private lastSource: NotebookSource | undefined;
```

- [ ] **Step 3: Update `show()` and the bindings**

Replace `show()` with:

```ts
  async show(): Promise<void> {
    const notebookEditor = vscode.window.activeNotebookEditor;
    if (notebookEditor) {
      this.ensurePanel();
      this.panel?.reveal(undefined, true);
      this.bindNotebook(notebookEditor.notebook);
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
```

Replace `bind()` with:

```ts
  private bindDocument(document: vscode.TextDocument): void {
    if (this.boundUri()?.toString() !== document.uri.toString()) {
      this.lastResult = undefined;
      this.lastSource = undefined;
      this.currentState = undefined;
    }
    this.bound = { kind: "file", document };
  }

  private bindNotebook(notebook: vscode.NotebookDocument): void {
    if (this.boundUri()?.toString() !== notebook.uri.toString()) {
      this.lastResult = undefined;
      this.lastSource = undefined;
      this.currentState = undefined;
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
```

- [ ] **Step 4: Register the notebook listeners**

In `ensurePanel()`, add these entries to the `panelDisposables.push(...)` call, after the existing text-editor listeners:

```ts
      vscode.window.onDidChangeNotebookEditorSelection((event) =>
        this.onNotebookSelectionChanged(event)
      ),
      vscode.window.onDidChangeActiveNotebookEditor((editor) =>
        this.onActiveNotebookEditorChanged(editor)
      ),
      vscode.workspace.onDidChangeNotebookDocument((event) =>
        this.onNotebookChanged(event)
      ),
```

Also change the configuration listener body:

```ts
          this.cache.clear();
          if (this.boundDocument) {
            void this.refresh(true);
          }
```

to:

```ts
          this.cache.clear();
          if (this.bound) {
            void this.refresh(true);
          }
```

- [ ] **Step 5: Make `renderResult` notebook-aware**

Replace `renderResult` with:

```ts
  private renderResult(
    result: AnalyzerResult,
    source?: NotebookSource
  ): void {
    this.lastSource = source;
    const errorDiagnostic = result.diagnostics.find(
      (item) => item.severity === "error"
    );
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
```

- [ ] **Step 6: Split `refresh()` and add `refreshNotebook()`**

Replace the beginning of `refresh()`:

```ts
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
```

with:

```ts
  private async refresh(force: boolean): Promise<void> {
    if (!this.panel || !this.bound) {
      return;
    }
    const bound = this.bound;
    if (bound.kind === "file" && bound.document.languageId !== "python") {
      this.postState({ kind: "notPython" });
      return;
    }
```

Leave the trust gate unchanged, then insert the notebook dispatch immediately after it:

```ts
    if (bound.kind === "notebook") {
      await this.refreshNotebook(bound.notebook, force);
      return;
    }
    const document = bound.document;
```

The file path continues with its existing mtime/cache/analyze logic, with one change: the cache write becomes

```ts
      this.cache.set(cacheKey, { stamp: mtimeMs, result });
```

and the cache hit comparison becomes

```ts
    if (!force && cached && cached.stamp === mtimeMs) {
```

and the hit renders `this.renderResult(cached.result);`.

Add `refreshNotebook()` after `refresh()`:

```ts
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
```

- [ ] **Step 7: Update the event handlers and jump**

Replace `onSaved()` with:

```ts
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
```

Replace `onActiveEditorChanged()` with:

```ts
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
```

Replace `onSelectionChanged()` with:

```ts
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
      const line = event.selections[0]?.active.line ?? 0;
      this.post({ type: "cursor", line: line + 1 });
    }, 100);
  }
```

Add the three notebook handlers after `onSelectionChanged()`:

```ts
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
    if (event.contentChanges.length === 0) {
      return;
    }
    this.scheduleRefresh();
  }

  private onActiveNotebookEditorChanged(
    editor: vscode.NotebookEditor | undefined
  ): void {
    if (!this.panel || !editor) {
      return;
    }
    const notebook = editor.notebook;
    const bound = this.bound;
    if (
      bound &&
      bound.kind === "notebook" &&
      bound.notebook.uri.toString() === notebook.uri.toString()
    ) {
      if (this.lastResult) {
        this.postGraph(this.lastResult);
      }
      return;
    }
    this.bindNotebook(notebook);
    void this.refresh(false);
  }
```

Replace `jump()` with:

```ts
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
      const editor = await vscode.window.showNotebookDocument(bound.notebook, {
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
```

- [ ] **Step 8: Add the notebook toolbar menu and bump the version**

In `package.json`, change `"version": "0.1.0"` to `"version": "0.2.0"`.

In `package-lock.json`, change **both** `"version": "0.1.0"` entries (line 3 and line 9) to `"version": "0.2.0"`.

Replace the `menus` block:

```json
    "menus": {
      "editor/title": [
        {
          "command": "pyCallMap.show",
          "when": "editorLangId == python",
          "group": "navigation",
          "icon": "$(graph)"
        }
      ],
      "notebook/toolbar": [
        {
          "command": "pyCallMap.show",
          "when": "notebookType == jupyter-notebook",
          "group": "navigation",
          "icon": "$(graph)"
        }
      ]
    },
```

- [ ] **Step 9: Add the example notebook**

Create `examples/demo.ipynb`:

```json
{
 "cells": [
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": [
    "# PyCallMap notebook demo\n",
    "The whole notebook is analyzed as one program."
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "def load():\n",
    "    return [1, 2, 3]\n",
    "\n",
    "\n",
    "def total(values):\n",
    "    return sum(values)\n"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "def main():\n",
    "    data = load()\n",
    "    print(total(data))\n",
    "\n",
    "\n",
    "main()\n"
   ]
  }
 ],
 "metadata": {
  "kernelspec": {
   "display_name": "Python 3",
   "language": "python",
   "name": "python3"
  },
  "language_info": {
   "name": "python",
   "version": "3.11"
  }
 },
 "nbformat": 4,
 "nbformat_minor": 5
}
```

- [ ] **Step 10: Update `CHANGELOG.md`**

Insert above `## 0.1.0 - 2026-10-17`:

```markdown
## 0.2.0 - 2026-10-17

- Analyze a Jupyter notebook (`.ipynb`) as one program across all code cells.
- Cross-cell edges, cell-aware tooltips (`Cell N · line M`).
- Click a node or edge to jump to the owning cell; the active cell's functions are highlighted.
- Notebook toolbar button; notebooks re-analyze on change.
```

- [ ] **Step 11: Update `README.md`**

Make these edits:

1. Intro line 3: change to `把 Python 文件或 Jupyter notebook 里的函数调用关系画成一张横向调用图，点击节点即可跳到对应代码。`
2. Intro line 5: change `a single Python file` to `a single Python file or notebook`.
3. Features: add `- 支持 Jupyter notebook：所有代码单元格合成一张调用图` after the first bullet.
4. Usage section: replace the numbered list with:

```markdown
1. 打开一个 `.py` 文件或 `.ipynb` notebook。
2. 执行命令 `PyCallMap: Show Function Call Graph`，或点击编辑器 / notebook 工具栏的图图标。
3. 在右侧面板查看调用图。
```

5. Known limitations: add these bullets at the end of the list:

```markdown
- Notebook 按文档顺序分析，忽略 `execution_count`
- 以 `%%` 开头的 cell 会被整体跳过；`%`、`!`、`?` 魔术命令行按 `pass` 处理，因此其中的代码不会被分析
- Notebook 只分析 code cell，忽略 markdown 和输出
```

6. Privacy section: replace the first sentence with `PyCallMap 只读取当前 Python 文件或 notebook 的 code cell，并把 notebook 单元格临时拼接成本地 `.py` 文件交给标准库分析脚本；该临时文件在分析结束后立即删除。`
7. English summary: change `a single Python file's function call graph` to `a single Python file's or notebook's function call graph` and add `Notebook cells are concatenated in document order into a temporary local file; no cell code is executed.` before `Analysis runs locally...`.

- [ ] **Step 12: Run the full verification suite**

```bash
npm run typecheck
npm test
python -m unittest discover -s test/python -p "test_*.py" -v
npm run build
```

Expected:
- `npm run typecheck`: no errors.
- `npm test`: all suites pass (notebook 8, graph 13, pythonBridge 15, lineNumbers 2, integration 3).
- Python unittest: 31 tests pass.
- `npm run build`: writes `dist/extension.js` and `media/main.js`.

- [ ] **Step 13: Manual smoke test**

```bash
npm run build
code --extensionDevelopmentPath=E:\me\插件 --user-data-dir=C:\temp\pycallmap-dev-profile --new-window
```

In the dev host: open `examples/demo.ipynb`, click the graph icon in the notebook toolbar.
Expected: one left-to-right graph with `load()`, `total()`, `main()`; edges `main → load` and `main → total`; hovering shows `Cell 1 · line 1` / `Cell 2 · line 1`; clicking a node selects that cell; selecting the second cell outlines `main()` (and `total()` if it were defined there — it is defined in cell 1, so only `main()` highlights).

- [ ] **Step 14: Commit**

```bash
git add src/controller.ts package.json package-lock.json CHANGELOG.md README.md examples/demo.ipynb
git commit -m "feat: open PyCallMap from Jupyter notebooks"
```

---

## Self-Review Notes

**Spec coverage:**
- Concatenation, magic neutralisation, `%%` skipping, empty cells, exact ranges → Task 1.
- Temp file, UTF-8, `finally` cleanup, empty-notebook shortcut, locations → Task 2.
- `location` / `locations` / `endLine` protocol fields, tooltip preference, range highlight → Task 3.
- Bound-source union, notebook jump via `showNotebookDocument` + `InCenter`, cell-granular selection highlight, `onDidChangeNotebookDocument` refresh, version-keyed cache, trust gate, error mapping to `Cell N` → Task 4.
- `notebook/toolbar` menu, `notebookType == jupyter-notebook` → Task 4.
- Version `0.2.0`, CHANGELOG, README limitations → Task 4.

**Deliberate detail:** `cellIndex` throughout is the index in `notebook.getCells()` (including markdown cells), because `NotebookRange` and jump operate on that index space. `codeNumber` is the 1-based ordinal among code cells and is display-only. Task 2's integration test passes cell indices `0` and `2` specifically to prove markdown cells do not shift jump/mapping.

**Known non-goal:** notebook cursor highlighting is cell-granular. The stable API does not expose an intra-cell cursor line, as recorded in the spec.
