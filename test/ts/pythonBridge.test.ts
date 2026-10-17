import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { AnalyzerResult } from "../../src/protocol";
import {
  AnalyzerError,
  PythonNotFoundError,
  analyzeFile,
  parseAnalyzerOutput,
  pythonCandidates,
  runAnalyzer,
  usableCandidates,
  type BridgeEnvironment,
} from "../../src/pythonBridge";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function asSpawn(child: FakeChild): typeof import("node:child_process").spawn {
  return (() => child as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
}

function sampleResult(): AnalyzerResult {
  return {
    version: 1,
    file: "C:/project/app.py",
    functions: [
      {
        id: "main",
        name: "main",
        signature: "main()",
        kind: "function",
        owner: null,
        parent: null,
        line: 1,
        endLine: 1,
        entry: true,
        unused: false,
        externalCalls: 0,
      },
    ],
    edges: [],
    diagnostics: [],
    stats: { functionCount: 1, edgeCount: 0, parsedInMs: 1 },
  };
}

function env(overrides: Partial<BridgeEnvironment> = {}): BridgeEnvironment {
  return {
    platform: "linux",
    pathExists: () => true,
    workspaceFolder: "/work",
    pythonPathSetting: "",
    ...overrides,
  };
}

describe("pythonCandidates", () => {
  it("orders configured path, venv, then PATH candidates", () => {
    expect(pythonCandidates(env({ pythonPathSetting: "/custom/python" }))).toEqual([
      "/custom/python",
      path.join("/work", ".venv", "bin", "python"),
      "python3",
      "python",
    ]);
  });

  it("uses Scripts/python.exe on Windows", () => {
    expect(
      pythonCandidates(env({ platform: "win32", workspaceFolder: "C:/work" }))
    ).toEqual([
      path.join("C:/work", ".venv", "Scripts", "python.exe"),
      "python",
      "python3",
    ]);
  });
});

describe("usableCandidates", () => {
  it("drops missing absolute paths but keeps PATH names", () => {
    const result = usableCandidates(
      env({ pathExists: (candidate) => candidate === path.join("/work", ".venv", "bin", "python") })
    );
    expect(result).toEqual([
      path.join("/work", ".venv", "bin", "python"),
      "python3",
      "python",
    ]);
  });
});

describe("parseAnalyzerOutput", () => {
  it("parses a valid result", () => {
    expect(parseAnalyzerOutput(JSON.stringify(sampleResult()))).toEqual(sampleResult());
  });

  it("rejects invalid JSON", () => {
    expect(() => parseAnalyzerOutput("not json")).toThrow(AnalyzerError);
  });

  it("rejects an unsupported version", () => {
    expect(() => parseAnalyzerOutput(JSON.stringify({ ...sampleResult(), version: 2 }))).toThrow(
      AnalyzerError
    );
  });

  it("rejects a missing signature field", () => {
    const data = sampleResult();
    delete (data.functions[0] as Partial<AnalyzerResult["functions"][number]>).signature;
    expect(() => parseAnalyzerOutput(JSON.stringify(data))).toThrow(AnalyzerError);
  });
});

describe("runAnalyzer", () => {
  it("resolves when the process exits successfully", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
    });
    child.stdout.emit("data", Buffer.from(JSON.stringify(sampleResult())));
    child.emit("close", 0);
    await expect(promise).resolves.toEqual(sampleResult());
  });

  it("rejects on a non-zero exit code", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
    });
    child.stderr.emit("data", Buffer.from("boom"));
    child.emit("close", 1);
    await expect(promise).rejects.toThrow("exited with code 1");
  });

  it("rejects when the interpreter is missing", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("missing-python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
    });
    child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    await expect(promise).rejects.toBeInstanceOf(PythonNotFoundError);
  });

  it("kills the process on timeout", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
      timeoutMs: 20,
    });
    await expect(promise).rejects.toThrow("timed out");
    expect(child.killed).toBe(true);
  });

  it("rejects when output exceeds the limit", async () => {
    const child = new FakeChild();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
      maxOutputBytes: 8,
    });
    child.stdout.emit("data", Buffer.from("0123456789"));
    await expect(promise).rejects.toThrow("exceeded");
    expect(child.killed).toBe(true);
  });

  it("kills the process when aborted", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const promise = runAnalyzer("python", "analyze.py", "app.py", {
      spawn: asSpawn(child),
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
    expect(child.killed).toBe(true);
  });
});

describe("analyzeFile", () => {
  it("falls through to the next candidate on ENOENT", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const children = [first, second];
    let index = 0;
    const spawn = (() => children[index++] as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
    const promise = analyzeFile("app.py", env({ workspaceFolder: undefined }), "analyze.py", {
      spawn,
    });
    first.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    await new Promise((resolve) => setImmediate(resolve));
    second.stdout.emit("data", Buffer.from(JSON.stringify(sampleResult())));
    second.emit("close", 0);
    await expect(promise).resolves.toEqual(sampleResult());
    expect(index).toBe(2);
  });

  it("throws PythonNotFoundError when every candidate fails with ENOENT", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const children = [first, second];
    let index = 0;
    const spawn = (() => children[index++] as unknown as ChildProcess) as unknown as typeof import("node:child_process").spawn;
    const promise = analyzeFile("app.py", env({ workspaceFolder: undefined }), "analyze.py", {
      spawn,
    });
    first.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    await new Promise((resolve) => setImmediate(resolve));
    second.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    await expect(promise).rejects.toBeInstanceOf(PythonNotFoundError);
  });
});
