import type { ColorScheme } from "./webview/palettes";

export type FunctionKind = "function" | "method" | "nested";

export interface FunctionNode {
  id: string;
  name: string;
  signature: string;
  kind: FunctionKind;
  owner: string | null;
  parent: string | null;
  line: number;
  endLine: number;
  entry: boolean;
  unused: boolean;
  externalCalls: number;
  location?: string;
}

export interface CallEdge {
  id: string;
  source: string;
  target: string;
  lines: number[];
  cyclic: boolean;
  locations?: string[];
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  line: number;
  column: number;
}

export interface AnalyzerStats {
  functionCount: number;
  edgeCount: number;
  parsedInMs: number;
}

export interface AnalyzerResult {
  version: 1;
  file: string;
  functions: FunctionNode[];
  edges: CallEdge[];
  diagnostics: Diagnostic[];
  stats: AnalyzerStats;
}

export type WebviewState =
  | { kind: "loading" }
  | { kind: "notPython" }
  | { kind: "empty" }
  | { kind: "error"; title: string; detail: string; canOpenSettings: boolean };

export type HostToWebview =
  | { type: "graph"; payload: AnalyzerResult; showUncalled: boolean; warning?: string }
  | { type: "cursor"; line: number; endLine?: number }
  | { type: "scheme"; scheme: ColorScheme }
  | { type: "state"; state: WebviewState };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "scheme"; scheme: ColorScheme }
  | { type: "jump"; line: number }
  | { type: "refresh" }
  | { type: "openSettings" };
