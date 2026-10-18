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
