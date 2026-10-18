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
