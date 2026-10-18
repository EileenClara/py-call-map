import type { AnalyzerResult, FunctionNode } from "../protocol";

export interface GraphNodeData {
  id: string;
  label: string;
  line: number;
  endLine: number;
  entry: boolean;
  unused: boolean;
  kind: FunctionNode["kind"];
  signature: string;
  externalCalls: number;
  location?: string;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  lines: number[];
  cyclic: boolean;
  label: string;
  locations?: string[];
}

export type GraphElement =
  | { data: GraphNodeData }
  | { data: GraphEdgeData };

export function nodeLabel(
  fn: FunctionNode,
  byId: Map<string, FunctionNode>
): string {
  if (fn.kind === "method" && fn.owner) {
    return `${fn.owner}.${fn.name}()`;
  }
  if (fn.kind === "nested" && fn.parent) {
    const parent = byId.get(fn.parent);
    const parentName = parent
      ? parent.kind === "method" && parent.owner
        ? `${parent.owner}.${parent.name}`
        : parent.name
      : fn.parent;
    return `${parentName} › ${fn.name}()`;
  }
  return `${fn.name}()`;
}

export function reachableFromEntries(result: AnalyzerResult): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of result.edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }
  const seen = new Set<string>();
  const stack = result.functions
    .filter((fn) => fn.entry)
    .map((fn) => fn.id);
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        stack.push(next);
      }
    }
  }
  return seen;
}

export function visibleFunctions(
  result: AnalyzerResult,
  showUncalled: boolean
): FunctionNode[] {
  if (showUncalled || !result.functions.some((fn) => fn.entry)) {
    return result.functions;
  }
  const reachable = reachableFromEntries(result);
  return result.functions.filter((fn) => reachable.has(fn.id));
}

export function buildElements(
  result: AnalyzerResult,
  showUncalled: boolean
): GraphElement[] {
  const byId = new Map(result.functions.map((fn) => [fn.id, fn]));
  const visible = visibleFunctions(result, showUncalled);
  const visibleIds = new Set(visible.map((fn) => fn.id));
  const nodes: GraphElement[] = visible.map((fn) => ({
    data: {
      id: fn.id,
      label: nodeLabel(fn, byId),
      line: fn.line,
      endLine: fn.endLine,
      entry: fn.entry,
      unused: fn.unused,
      kind: fn.kind,
      signature: fn.signature,
      externalCalls: fn.externalCalls,
      location: fn.location,
    },
  }));
  const edges: GraphElement[] = result.edges
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .map((edge) => ({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        lines: edge.lines,
        cyclic: edge.cyclic,
        label: edge.lines.length > 1 ? `×${edge.lines.length}` : "",
        locations: edge.locations,
      },
    }));
  return [...nodes, ...edges];
}

export function findFunctionAtLine(
  functions: FunctionNode[],
  line: number
): FunctionNode | undefined {
  return functions
    .filter((fn) => fn.line <= line && line <= fn.endLine)
    .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
}
