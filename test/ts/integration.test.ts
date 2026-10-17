import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
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
});
