import path from "node:path";
import type { ResolvedTarget } from "../safety/target.ts";
import {
  ENGINE_VERSION,
  MAX_DEPTH,
  MAX_REQS_PER_SEC,
  MAX_URLS,
  MEMORY_LIMIT,
  REQUEST_TIMEOUT_SECONDS,
  USER_AGENT,
  WORKERS,
} from "../constants.ts";

export type SiteOnePaths = {
  jsonFile: string;
  htmlFile: string;
};

export function buildSiteOneArgs(target: ResolvedTarget, paths: SiteOnePaths): string[] {
  const args = [
    `--url=${target.href}`,
    `--max-depth=${MAX_DEPTH}`,
    `--max-visited-urls=${MAX_URLS}`,
    `--max-reqs-per-sec=${MAX_REQS_PER_SEC}`,
    `--workers=${WORKERS}`,
    `--timeout=${REQUEST_TIMEOUT_SECONDS}`,
    `--memory-limit=${MEMORY_LIMIT}`,
    "--hide-progress-bar",
    "--no-color",
    "--disable-javascript",
    "--disable-styles",
    "--disable-fonts",
    "--disable-images",
    `--allowed-domain-for-crawling=${target.host}`,
    `--user-agent=${USER_AGENT}`,
    "--timezone=Asia/Shanghai",
    "--result-storage=memory",
    `--result-storage-dir=${path.join(path.dirname(paths.jsonFile), "tmp", "result-storage")}`,
    "--http-cache-dir=off",
    `--output-html-report=${paths.htmlFile}`,
    `--output-json-file=${paths.jsonFile}`,
  ];
  for (const address of target.addresses) {
    const ip = address.includes(":") ? `[${address}]` : address;
    args.push(`--resolve=${target.host}:${target.port}:${ip}`);
  }
  return args;
}

export const FORBIDDEN_ARG_PATTERN =
  /mail-|upload|offline-export|ignore-robots|proxy|websocket|browser|screenshots|ai-|http-auth|accept-invalid|add-random-query/i;

export function assertSafeArgs(args: string[]): void {
  if (args.some((arg) => FORBIDDEN_ARG_PATTERN.test(arg))) {
    throw new Error("SiteOne 参数超出 M0 允许范围。");
  }
  if (!args.some((arg) => arg.startsWith(`--url=`))) {
    throw new Error("缺少 --url。");
  }
  void ENGINE_VERSION;
}
