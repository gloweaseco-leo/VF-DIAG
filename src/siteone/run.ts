import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { WALL_CLOCK_MS } from "../constants.ts";
import type { ResolvedTarget } from "../safety/target.ts";
import { assertSafeArgs, buildSiteOneArgs } from "./args.ts";
import { killProcessTree, spawnCrawler } from "./process.ts";

export type CrawlResult = {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  jsonText: string | null;
  html: Buffer | null;
  errorCode: string | null;
  errorMessage: string | null;
};

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export async function runSiteOne(options: {
  bin: string;
  target: ResolvedTarget;
  jsonFile: string;
  htmlFile: string;
  signal: AbortSignal;
  wallClockMs?: number;
  command?: { bin: string; args: string[] };
}): Promise<CrawlResult> {
  const bin = options.command?.bin ?? options.bin;
  try {
    await access(bin);
  } catch {
    return empty("ENGINE_BINARY_MISSING", "没有找到 SiteOne v2.5.1 可执行文件。");
  }

  const args = options.command?.args ?? buildSiteOneArgs(options.target, {
    jsonFile: options.jsonFile,
    htmlFile: options.htmlFile,
  });
  if (!options.command) assertSafeArgs(args);
  const cwd = path.dirname(options.jsonFile);
  await mkdir(path.join(cwd, "tmp", "ai-cache"), { recursive: true });
  await mkdir(path.join(cwd, "tmp", "result-storage"), { recursive: true });
  const child = spawnCrawler(bin, args, cwd);
  const wallClockMs = options.wallClockMs ?? WALL_CLOCK_MS;
  let timedOut = false;
  let cancelled = false;

  const chunks: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBytes > 8_192) return;
    chunks.push(chunk);
    stderrBytes += chunk.length;
  });
  const finished = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void killProcessTree(child);
  }, wallClockMs);
  const onAbort = () => {
    cancelled = true;
    void killProcessTree(child);
  };
  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener("abort", onAbort, { once: true });

  const exitCode = await finished;
  clearTimeout(timer);
  options.signal.removeEventListener("abort", onAbort);

  if (cancelled) return empty("CANCELLED", "扫描已取消。");
  if (timedOut) return empty("ENGINE_TIMEOUT", "扫描超过 180 秒，进程树已终止。");

  const jsonText = await readBounded(options.jsonFile);
  const html = await readBoundedBuffer(options.htmlFile);
  if (jsonText === "too-large" || html === "too-large") {
    return empty("ENGINE_OUTPUT_TOO_LARGE", "SiteOne 输出超过 20MB，已拒绝发布。");
  }
  if (!jsonText) {
    const detail = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .slice(0, 400);
    return {
      ...empty("ENGINE_FAILED", detail ? `SiteOne 没有留下 JSON。${detail}` : "SiteOne 没有留下可解析的 JSON。"),
      exitCode,
      html: html === "too-large" ? null : html,
    };
  }
  return {
    exitCode,
    timedOut: false,
    cancelled: false,
    jsonText,
    html,
    errorCode: null,
    errorMessage: null,
  };
}

async function readBounded(file: string): Promise<string | null | "too-large"> {
  try {
    const data = await readFile(file);
    if (data.byteLength > MAX_OUTPUT_BYTES) return "too-large";
    return data.toString("utf8");
  } catch {
    return null;
  }
}

async function readBoundedBuffer(file: string): Promise<Buffer | null | "too-large"> {
  try {
    const data = await readFile(file);
    if (data.byteLength > MAX_OUTPUT_BYTES) return "too-large";
    return data;
  } catch {
    return null;
  }
}

function empty(errorCode: string, errorMessage: string): CrawlResult {
  return {
    exitCode: null,
    timedOut: errorCode === "ENGINE_TIMEOUT",
    cancelled: errorCode === "CANCELLED",
    jsonText: null,
    html: null,
    errorCode,
    errorMessage,
  };
}
