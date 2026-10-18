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
