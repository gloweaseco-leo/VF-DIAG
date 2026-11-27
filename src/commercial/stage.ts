import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SiteOneJson } from "../report/types.ts";
import { cleanSiteOne, htmlExclusiveTables, htmlSourceMarkers } from "./clean.ts";
import { certificateTrust, composeCommercialReport, countResponses, fillUnstatedCounts, readEngineScores, sameSite, sourceCountMismatch } from "./compose.ts";
import { ModelCallError } from "./qwen.ts";
import { deriveScoreScale } from "./score-scale.ts";

export type Analyzer = (input: { cleanText: string; signal: AbortSignal }) => Promise<{ analysis: unknown; receipt: Record<string, unknown> }>;

type Receipt = {
  siteone_sha256: string;
  request_sent: boolean;
  valid: boolean;
  code: string | null;
  reused: boolean;
  dropped: string[];
  model_receipt: Record<string, unknown> | null;
};

export async function produceCommercial(options: {
  dir: string;
  siteone: SiteOneJson;
  siteoneText: string;
  html: string | null;
  host: string;
  jobRef: string;
  synthetic: boolean;
  generatedAt: string;
  signal: AbortSignal;
  analyze?: Analyzer;
  blocked?: { code: string; message: string };
}): Promise<{ available: boolean; code: string | null }> {
  const sha = createHash("sha256").update(options.siteoneText).digest("hex");
  const existing = await readJson(path.join(options.dir, "analysis.json"));
  const previous = await readReceipt(options.dir);
  if (existing && previous?.siteone_sha256 === sha && previous.valid) {
    return writeReport(options, existing, sha, true, previous.model_receipt);
  }
  if (options.blocked) {
    await writeError(options.dir, options.blocked.code, options.blocked.message);
    return { available: false, code: options.blocked.code };
  }
  if (previous?.siteone_sha256 === sha && previous.request_sent && !previous.valid) {
    await writeError(options.dir, "MODEL_INTERRUPTED", "上次模型调用没有留下可用分析，为避免重复付费，没有再次调用。");
    return { available: false, code: "MODEL_INTERRUPTED" };
  }
  if (!options.analyze) {
    await writeError(options.dir, "COMMERCIAL_NOT_CONFIGURED", "模型未配置，技术报告已保留，商业报告未生成。");
    return { available: false, code: "COMMERCIAL_NOT_CONFIGURED" };
  }
  if (options.signal.aborted) throw abortError();
  await writeReceipt(options.dir, { siteone_sha256: sha, request_sent: true, valid: false, code: "MODEL_PENDING", reused: false, dropped: [], model_receipt: null });
  let analysis: unknown;
  let modelReceipt: Record<string, unknown> | null = null;
  try {
    const result = await options.analyze({ cleanText: cleanSiteOne(options.siteone, options.html), signal: options.signal });
    analysis = result.analysis;
    modelReceipt = result.receipt;
  } catch (error) {
    const code = error instanceof ModelCallError ? error.code : options.signal.aborted ? "CANCELLED" : "MODEL_FAILED";
    const message = error instanceof Error ? error.message : "模型调用失败。";
    if (options.signal.aborted) throw abortError();
    await writeReceipt(options.dir, { siteone_sha256: sha, request_sent: true, valid: false, code, reused: false, dropped: [], model_receipt: null });
    await writeError(options.dir, code, message);
    return { available: false, code };
  }
  if (options.signal.aborted) throw abortError();
  await writeFile(path.join(options.dir, "analysis.json"), JSON.stringify(analysis));
  return writeReport(options, analysis, sha, false, modelReceipt);
}

async function writeReport(
  options: { dir: string; siteone: SiteOneJson; host: string; generatedAt: string; html: string | null; jobRef?: string; synthetic?: boolean },
  analysis: unknown,
  sha: string,
  reused: boolean,
  modelReceipt: Record<string, unknown> | null,
): Promise<{ available: boolean; code: string | null }> {
  const counts = countResponses(options.siteone.results);
  const aligned = fillUnstatedCounts(analysis, counts);
  const profile = aligned && typeof aligned === "object" ? (aligned as { source_profile?: { target_domain?: unknown } }).source_profile : undefined;
  const domain = typeof profile?.target_domain === "string" ? profile.target_domain : "";
  if (!sameSite(domain, options.host)) {
    await fail(options.dir, sha, reused, modelReceipt, "SOURCE_MISMATCH", "分析的网站和本次扫描目标不一致，客户报告未发布。");
    return { available: false, code: "SOURCE_MISMATCH" };
  }
  const mismatch = sourceCountMismatch(aligned, counts);
  if (mismatch) {
    await fail(options.dir, sha, reused, modelReceipt, "SOURCE_MISMATCH", mismatch);
    return { available: false, code: "SOURCE_MISMATCH" };
  }
  const scale = options.html ? deriveScoreScale(options.html) : null;
  const composed = composeCommercialReport({
    analysis: aligned,
    generatedAt: options.generatedAt,
    jobRef: options.jobRef,
    synthetic: options.synthetic,
    scoreScale: scale,
    htmlOnlyTables: htmlExclusiveTables(options.html, Object.keys(options.siteone.tables ?? {})),
    jsonTables: Object.keys(options.siteone.tables ?? {}),
    htmlMarkers: htmlSourceMarkers(options.html),
    engineScores: readEngineScores(options.siteone.qualityScores),
    certificateTrust: certificateTrust(options.siteone.tables?.["certificate-info"]?.rows as Array<Record<string, unknown>> | undefined),
  });
  if (!composed.ok) {
    await fail(options.dir, sha, reused, modelReceipt, composed.code, composed.message);
    return { available: false, code: composed.code };
  }
  await writeFile(path.join(options.dir, "commercial-report.json"), JSON.stringify(composed.report));
  await writeReceipt(options.dir, {
    siteone_sha256: sha,
    request_sent: true,
    valid: true,
    code: null,
    reused,
    dropped: composed.dropped,
    model_receipt: modelReceipt,
  });
  return { available: true, code: null };
}

async function fail(dir: string, sha: string, reused: boolean, modelReceipt: Record<string, unknown> | null, code: string, message: string): Promise<void> {
  await writeReceipt(dir, { siteone_sha256: sha, request_sent: true, valid: false, code, reused, dropped: [], model_receipt: modelReceipt });
  await writeError(dir, code, message);
}

async function writeError(dir: string, code: string, message: string): Promise<void> {
  await writeFile(path.join(dir, "commercial-error.json"), JSON.stringify({ code, message }));
}

async function writeReceipt(dir: string, receipt: Receipt): Promise<void> {
  await writeFile(path.join(dir, "commercial-receipt.json"), JSON.stringify(receipt));
}

async function readReceipt(dir: string): Promise<Receipt | null> {
  const value = await readJson(path.join(dir, "commercial-receipt.json"));
  if (!value || typeof value !== "object") return null;
  return value as Receipt;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
