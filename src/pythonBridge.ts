import { spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AnalyzerResult } from "./protocol";

export class AnalyzerError extends Error {
  constructor(message: string, readonly detail = "") {
    super(message);
    this.name = "AnalyzerError";
  }
}

export class PythonNotFoundError extends AnalyzerError {
  constructor() {
    super("Python interpreter not found");
    this.name = "PythonNotFoundError";
  }
}

export interface BridgeEnvironment {
  platform: NodeJS.Platform;
  pathExists: (candidate: string) => boolean;
  workspaceFolder: string | undefined;
  pythonPathSetting: string;
}

export interface RunDeps {
  spawn: typeof nodeSpawn;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function pythonCandidates(env: BridgeEnvironment): string[] {
  const candidates: string[] = [];
  const configured = env.pythonPathSetting.trim();
  if (configured) {
    candidates.push(configured);
  }
  if (env.workspaceFolder) {
    candidates.push(
      env.platform === "win32"
        ? path.join(env.workspaceFolder, ".venv", "Scripts", "python.exe")
        : path.join(env.workspaceFolder, ".venv", "bin", "python")
    );
  }
  if (env.platform === "win32") {
    candidates.push("python", "python3");
  } else {
    candidates.push("python3", "python");
  }
  return candidates;
}

export function usableCandidates(env: BridgeEnvironment): string[] {
  return pythonCandidates(env).filter((candidate) => {
    if (candidate.includes("/") || candidate.includes("\\")) {
      return env.pathExists(candidate);
    }
    return true;
  });
}

export function runAnalyzer(
  python: string,
  scriptPath: string,
  filePath: string,
  deps: RunDeps
): Promise<AnalyzerResult> {
  return new Promise((resolve, reject) => {
    if (deps.signal?.aborted) {
      reject(new AnalyzerError("Analysis aborted"));
      return;
    }
    const child = deps.spawn(python, ["-I", scriptPath, "--file", filePath], {
      cwd: path.dirname(filePath),
      windowsHide: true,
    });
    const timeoutMs = deps.timeoutMs ?? 5000;
    const maxOutputBytes = deps.maxOutputBytes ?? 10 * 1024 * 1024;
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const onAbort = (): void => {
      child.kill();
      finish(new AnalyzerError("Analysis aborted"));
    };

    const finish = (error?: Error, result?: AnalyzerResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(result as AnalyzerResult);
      }
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(new AnalyzerError(`Analysis timed out after ${timeoutMs} ms`, stderr));
    }, timeoutMs);

    deps.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout += stdoutDecoder.write(chunk);
      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        finish(new AnalyzerError(`Analyzer output exceeded ${maxOutputBytes} bytes`, stderr));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (error) => {
      if (isEnoent(error)) {
        finish(new PythonNotFoundError());
      } else {
        finish(new AnalyzerError(`Failed to start Python: ${String(error)}`, stderr));
      }
    });
    child.on("close", (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (code !== 0) {
        finish(new AnalyzerError(`Analyzer exited with code ${code}`, stderr));
        return;
      }
      try {
        finish(undefined, parseAnalyzerOutput(stdout));
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}

export async function analyzeFile(
  filePath: string,
  env: BridgeEnvironment,
  scriptPath: string,
  deps: RunDeps
): Promise<AnalyzerResult> {
  for (const candidate of usableCandidates(env)) {
    if (deps.signal?.aborted) {
      throw new AnalyzerError("Analysis aborted");
    }
    try {
      return await runAnalyzer(candidate, scriptPath, filePath, deps);
    } catch (error) {
      if (error instanceof PythonNotFoundError) {
        continue;
      }
      throw error;
    }
  }
  throw new PythonNotFoundError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseAnalyzerOutput(raw: string): AnalyzerResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AnalyzerError("Analyzer returned invalid JSON", raw.slice(-2000));
  }
  if (
    !isRecord(data) ||
    data.version !== 1 ||
    typeof data.file !== "string" ||
    !Array.isArray(data.functions) ||
    !Array.isArray(data.edges) ||
    !Array.isArray(data.diagnostics) ||
    !isRecord(data.stats)
  ) {
    throw new AnalyzerError("Analyzer returned an invalid result", raw.slice(-2000));
  }
  for (const item of data.functions) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.signature !== "string" ||
      !["function", "method", "nested"].includes(item.kind as string) ||
      (item.owner !== null && typeof item.owner !== "string") ||
      (item.parent !== null && typeof item.parent !== "string") ||
      typeof item.line !== "number" ||
      typeof item.endLine !== "number" ||
      typeof item.entry !== "boolean" ||
      typeof item.unused !== "boolean" ||
      typeof item.externalCalls !== "number"
    ) {
      throw new AnalyzerError("Analyzer returned an invalid function node", raw.slice(-2000));
    }
  }
  for (const item of data.edges) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.source !== "string" ||
      typeof item.target !== "string" ||
      !Array.isArray(item.lines) ||
      item.lines.some((line) => typeof line !== "number") ||
      typeof item.cyclic !== "boolean"
    ) {
      throw new AnalyzerError("Analyzer returned an invalid edge", raw.slice(-2000));
    }
  }
  for (const item of data.diagnostics) {
    if (
      !isRecord(item) ||
      (item.severity !== "error" && item.severity !== "warning") ||
      typeof item.message !== "string" ||
      typeof item.line !== "number" ||
      typeof item.column !== "number"
    ) {
      throw new AnalyzerError("Analyzer returned an invalid diagnostic", raw.slice(-2000));
    }
  }
  const stats = data.stats;
  if (
    typeof stats.functionCount !== "number" ||
    typeof stats.edgeCount !== "number" ||
    typeof stats.parsedInMs !== "number"
  ) {
    throw new AnalyzerError("Analyzer returned invalid stats", raw.slice(-2000));
  }
  return data as unknown as AnalyzerResult;
}
