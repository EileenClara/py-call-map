import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeNotebook } from "../../src/notebookAnalysis";
import { parseAnalyzerOutput } from "../../src/pythonBridge";

function findPython(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? ["python", "python3", "py"]
      : ["python", "python3"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-c", "pass"], { stdio: "ignore" });
    if (result.error === undefined && result.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

const python = findPython();

function runAnalyzerProcess(
  interpreter: string,
  scriptPath: string,
  filePath: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(interpreter, ["-I", scriptPath, "--file", filePath], {
      cwd: path.dirname(filePath),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

describe.skipIf(python === undefined)("analyzer integration", () => {
  it("parses non-ASCII identifiers without mojibake and wires caller edges", async () => {
    const interpreter = python as string;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pycallmap-"));
    try {
      const source = [
        "def 你好():",
        "    pass",
        "",
        "",
        "def main():",
        "    你好()",
        "",
      ].join("\n");
      const filePath = path.join(tmpDir, "sample.py");
      fs.writeFileSync(filePath, source, { encoding: "utf8" });

      const scriptPath = path.resolve(process.cwd(), "python", "analyze.py");
      const { code, stdout, stderr } = await runAnalyzerProcess(
        interpreter,
        scriptPath,
        filePath
      );

      expect(code, `analyzer failed:\n${stderr}`).toBe(0);

      const result = parseAnalyzerOutput(stdout);
      expect(result.version).toBe(1);
      expect(result.file).toBe(filePath);
      expect(result.diagnostics).toEqual([]);

      const ids = result.functions.map((fn) => fn.id);
      expect(ids).toContain("你好");
      expect(ids).toContain("main");

      const edge = result.edges.find(
        (item) => item.source === "main" && item.target === "你好"
      );
      expect(edge).toBeDefined();
      expect(edge?.lines).toContain(6);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
});

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
