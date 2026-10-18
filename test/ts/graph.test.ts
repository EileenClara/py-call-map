import { describe, expect, it } from "vitest";
import type { AnalyzerResult, FunctionNode } from "../../src/protocol";
import {
  buildElements,
  findFunctionAtLine,
  nodeLabel,
  reachableFromEntries,
  visibleFunctions,
} from "../../src/webview/graph";

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

function sample(): AnalyzerResult {
  const functions = [
    fn({ id: "main", entry: true, line: 10, endLine: 14 }),
    fn({ id: "a", line: 1, endLine: 3 }),
    fn({ id: "b", line: 5, endLine: 7 }),
    fn({ id: "C.run", name: "run", kind: "method", owner: "C", line: 20, endLine: 22 }),
    fn({ id: "outer", line: 30, endLine: 40 }),
    fn({ id: "outer.inner", name: "inner", kind: "nested", parent: "outer", line: 32, endLine: 34 }),
    fn({ id: "dead", line: 50, endLine: 52, unused: true }),
  ];
  return {
    version: 1,
    file: "/work/app.py",
    functions,
    edges: [
      { id: "e1", source: "main", target: "a", lines: [11, 12], cyclic: false },
      { id: "e2", source: "a", target: "b", lines: [2], cyclic: false },
    ],
    diagnostics: [],
    stats: { functionCount: functions.length, edgeCount: 2, parsedInMs: 1 },
  };
}

describe("nodeLabel", () => {
  const result = sample();
  const byId = new Map(result.functions.map((item) => [item.id, item]));

  it("labels top-level functions", () => {
    expect(nodeLabel(byId.get("a")!, byId)).toBe("a()");
  });

  it("labels methods with the class prefix", () => {
    expect(nodeLabel(byId.get("C.run")!, byId)).toBe("C.run()");
  });

  it("labels nested functions with the parent name", () => {
    expect(nodeLabel(byId.get("outer.inner")!, byId)).toBe("outer › inner()");
  });
});

describe("reachableFromEntries", () => {
  it("walks from entry nodes", () => {
    expect(reachableFromEntries(sample())).toEqual(new Set(["main", "a", "b"]));
  });
});

describe("visibleFunctions", () => {
  it("hides uncalled functions when an entry exists", () => {
    expect(visibleFunctions(sample(), false).map((item) => item.id)).toEqual([
      "main",
      "a",
      "b",
    ]);
  });

  it("shows everything when requested", () => {
    expect(visibleFunctions(sample(), true)).toHaveLength(7);
  });

  it("shows everything when there is no entry", () => {
    const result = sample();
    result.functions = result.functions.map((item) => ({ ...item, entry: false }));
    expect(visibleFunctions(result, false)).toHaveLength(7);
  });
});

describe("buildElements", () => {
  it("filters edges whose endpoints are hidden and labels repeated calls", () => {
    const elements = buildElements(sample(), false);
    const nodes = elements.filter((element) => !("source" in element.data));
    const edges = elements.filter((element) => "source" in element.data);
    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);
    const mainToA = edges.find(
      (element) => "source" in element.data && element.data.source === "main"
    );
    expect(mainToA && "label" in mainToA.data ? mainToA.data.label : "").toBe("×2");
  });

  it("keeps the unused flag and kind on node data", () => {
    const elements = buildElements(sample(), true);
    const nested = elements.find(
      (element) => "kind" in element.data && element.data.id === "outer.inner"
    );
    expect(nested && "kind" in nested.data ? nested.data.kind : "").toBe("nested");
    const dead = elements.find(
      (element) => "unused" in element.data && element.data.id === "dead"
    );
    expect(dead && "unused" in dead.data ? dead.data.unused : false).toBe(true);
  });

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
    expect(node && "externalCalls" in node.data ? node.data.location : undefined).toBe(
      "Cell 2 · line 1"
    );

    const edge = elements.find(
      (element) => "source" in element.data && element.data.id === "e1"
    );
    expect(
      edge && "locations" in edge.data ? edge.data.locations : undefined
    ).toEqual(["Cell 2 · line 2"]);
  });
});

describe("findFunctionAtLine", () => {
  const functions = sample().functions;

  it("prefers the innermost function", () => {
    expect(findFunctionAtLine(functions, 33)?.id).toBe("outer.inner");
  });

  it("finds an outer function", () => {
    expect(findFunctionAtLine(functions, 38)?.id).toBe("outer");
  });

  it("returns undefined outside all functions", () => {
    expect(findFunctionAtLine(functions, 99)).toBeUndefined();
  });
});
