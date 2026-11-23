import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTRACT_VERSION,
  ENGINE_VERSION,
  MAX_DEPTH,
  MAX_REQS_PER_SEC,
  MAX_URLS,
  RETENTION_DAYS,
  WALL_CLOCK_MS,
} from "../constants.ts";
import type { CreateJobBody } from "../http/request.ts";
import { projectReport } from "../report/project.ts";
import type { CustomerReport, SiteOneJson } from "../report/types.ts";
import type { Lookup, ResolvedTarget } from "../safety/target.ts";
import { evaluateTarget } from "../safety/target.ts";
import type { CrawlResult } from "../siteone/run.ts";

export type JobState =
  | "queued"
  | "validating"
  | "running"
  | "summarizing"
  | "complete"
  | "partial"
  | "failed"
  | "cancelled"
  | "expired";

export type JobRecord = {
  job_ref: string;
  contract_version: typeof CONTRACT_VERSION;
  state: JobState;
  created_at: string;
  updated_at: string;
  expires_at: string;
  target_url: string;
  target_host: string | null;
  language: "zh" | "en";
  report_language: "zh";
  synthetic: boolean;
  idempotency_key: string;
  body_hash: string;
  scope: {
    max_urls: number;
    max_depth: number;
    max_reqs_per_sec: number;
    wall_clock_seconds: number;
    browser: false;
  };
  checked_pages: number | null;
  remaining_unknown: true;
  reason_code: string | null;
  reason: string | null;
  report_available: boolean;
  engine_version: typeof ENGINE_VERSION;
};

export type JobStatus = {
  job_ref: string;
  state: JobState;
  updated_at: string;
  expires_at: string;
  scope: JobRecord["scope"];
  checked_pages: number | null;
  remaining_unknown: true;
  reason_code: string | null;
  reason: string | null;
  poll_after_seconds: number;
  report_available: boolean;
  target_host: string | null;
  synthetic: boolean;
  report_language: "zh";
};

type Runner = (options: {
  target: ResolvedTarget;
  jsonFile: string;
  htmlFile: string;
  signal: AbortSignal;
}) => Promise<CrawlResult>;

const ACTIVE = new Set<JobState>(["queued", "validating", "running", "summarizing"]);
const TERMINAL = new Set<JobState>(["complete", "partial", "failed", "cancelled", "expired"]);

export function createJobService(options: {
  dataDir: string;
  lookup: Lookup;
  syntheticHosts: ReadonlySet<string>;
  run: Runner;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const jobsDir = path.join(options.dataDir, "jobs");
  const aborts = new Map<string, AbortController>();
  let chain: Promise<unknown> = Promise.resolve();

  function lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function recover(): Promise<void> {
    await mkdir(jobsDir, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(jobsDir);
    for (const name of names) {
      const job = await readJob(name);
      if (!job) continue;
      if (Date.parse(job.expires_at) <= now().getTime()) {
        await writeJob({ ...job, state: "expired", report_available: false, updated_at: now().toISOString(), reason_code: "EXPIRED", reason: "报告已过期。" });
        continue;
      }
      if (ACTIVE.has(job.state)) {
        await writeJob({
          ...job,
          state: "failed",
          report_available: false,
          updated_at: now().toISOString(),
          reason_code: "WORKER_RESTARTED",
          reason: "Worker 重启前任务未结束，本次没有沿用中断的扫描。",
        });
      }
    }
  }

  async function create(body: CreateJobBody): Promise<{ status: number; body: unknown }> {
    return lock(async () => {
      const existing = await findByIdempotency(body.idempotency_key);
      const hash = bodyHash(body);
      if (existing) {
        if (existing.body_hash !== hash) {
          return error(409, "IDEMPOTENCY_CONFLICT", "同一个幂等键对应了不同的请求。");
        }
        return { status: 200, body: toStatus(existing) };
      }
      if (await hasActive()) {
        return error(429, "JOB_CAPACITY", "已有一个扫描在进行。M0 同时只跑一个任务。");
      }
      const created = now();
      const job: JobRecord = {
        job_ref: randomBytes(16).toString("base64url"),
        contract_version: CONTRACT_VERSION,
        state: "queued",
        created_at: created.toISOString(),
        updated_at: created.toISOString(),
        expires_at: new Date(created.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        target_url: body.url,
        target_host: null,
        language: body.language,
        report_language: "zh",
        synthetic: false,
        idempotency_key: body.idempotency_key,
        body_hash: hash,
        scope: {
          max_urls: MAX_URLS,
          max_depth: MAX_DEPTH,
          max_reqs_per_sec: MAX_REQS_PER_SEC,
          wall_clock_seconds: WALL_CLOCK_MS / 1000,
          browser: false,
        },
        checked_pages: null,
        remaining_unknown: true,
        reason_code: null,
        reason: null,
        report_available: false,
        engine_version: ENGINE_VERSION,
      };
      await writeJob(job);
      const controller = new AbortController();
      aborts.set(job.job_ref, controller);
      queueMicrotask(() => {
        void execute(job.job_ref, controller).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "任务执行失败。";
          return update(job.job_ref, {
            state: "failed",
            reason_code: "ENGINE_FAILED",
            reason: message,
            report_available: false,
          }).catch(() => undefined);
        });
      });
      return { status: 202, body: toStatus(job) };
    });
  }

  async function execute(jobRef: string, controller: AbortController): Promise<void> {
    const current = await readJob(jobRef);
    if (!current || current.state === "cancelled") return;
    await update(jobRef, { state: "validating" });
    const verdict = await evaluateTarget(current.target_url, {
      lookup: options.lookup,
      syntheticHosts: options.syntheticHosts,
    });
    if (!verdict.ok) {
      await update(jobRef, { state: "failed", reason_code: verdict.code, reason: verdict.message, report_available: false });
      aborts.delete(jobRef);
      return;
    }
    if (controller.signal.aborted) {
      await update(jobRef, { state: "cancelled", reason_code: "CANCELLED", reason: "扫描已取消。", report_available: false });
      aborts.delete(jobRef);
      return;
    }
    await update(jobRef, { state: "running", target_host: verdict.target.host, synthetic: verdict.target.synthetic });
    const dir = jobDir(jobRef);
    const result = await options.run({
      target: verdict.target,
      jsonFile: path.join(dir, "siteone.json"),
      htmlFile: path.join(dir, "siteone.html"),
      signal: controller.signal,
    });
    if (result.cancelled || controller.signal.aborted) {
      await update(jobRef, { state: "cancelled", reason_code: "CANCELLED", reason: "扫描已取消。", report_available: false });
      aborts.delete(jobRef);
      return;
    }
    if (result.errorCode || !result.jsonText) {
      await update(jobRef, {
        state: "failed",
        reason_code: result.errorCode ?? "ENGINE_FAILED",
        reason: result.errorMessage ?? "扫描没有产出可用结果。",
        report_available: false,
      });
      aborts.delete(jobRef);
      return;
    }
    let parsed: SiteOneJson;
    try {
      parsed = JSON.parse(result.jsonText) as SiteOneJson;
    } catch {
      await update(jobRef, { state: "failed", reason_code: "ENGINE_FAILED", reason: "SiteOne JSON 无法解析。", report_available: false });
      aborts.delete(jobRef);
      return;
    }
    const latest = await readJob(jobRef);
    if (latest?.state === "cancelled" || controller.signal.aborted) {
      await update(jobRef, { state: "cancelled", reason_code: "CANCELLED", reason: "扫描已取消。", report_available: false });
      aborts.delete(jobRef);
      return;
    }
    await update(jobRef, { state: "summarizing" });
    const engineVersion = typeof parsed.crawler?.version === "string" ? parsed.crawler.version : null;
    if (engineVersion && !(engineVersion === ENGINE_VERSION || engineVersion.startsWith(`${ENGINE_VERSION}.`))) {
      await update(jobRef, {
        state: "failed",
        reason_code: "ENGINE_VERSION_MISMATCH",
        reason: `SiteOne 版本是 ${engineVersion}，M0 只接受 ${ENGINE_VERSION}。`,
        report_available: false,
      });
      aborts.delete(jobRef);
      return;
    }
    const projected = projectReport({
      jobRef,
      inputUrl: verdict.target.href,
      host: verdict.target.host,
      synthetic: verdict.target.synthetic,
      generatedAt: now().toISOString(),
      siteone: parsed,
      engineVersion: engineVersion ?? ENGINE_VERSION,
    });
    if (!projected.ok) {
      await update(jobRef, { state: "failed", reason_code: projected.code, reason: projected.message, report_available: false });
      aborts.delete(jobRef);
      return;
    }
    await writeFile(path.join(dir, "report.json"), JSON.stringify(projected.report));
    const checked = projected.report.coverage.scanned_pages;
    const early = result.exitCode !== 0;
    await update(jobRef, {
      state: early ? "partial" : "complete",
      checked_pages: checked,
      report_available: true,
      reason_code: early ? "ENGINE_EXIT_NONZERO" : null,
      reason: early ? "扫描进程非正常结束，报告只覆盖已经写下的结果。" : null,
    });
    aborts.delete(jobRef);
  }

  async function get(jobRef: string): Promise<{ status: number; body: unknown }> {
    const job = await loadVisible(jobRef);
    if (!job) return error(404, "JOB_NOT_FOUND", "任务不存在。");
    if (job.state === "expired") return error(410, "EXPIRED", "报告已过期。");
    return { status: 200, body: toStatus(job) };
  }

  async function report(jobRef: string): Promise<{ status: number; body: unknown }> {
    const job = await loadVisible(jobRef);
    if (!job) return error(404, "JOB_NOT_FOUND", "任务不存在。");
    if (job.state === "expired") return error(410, "EXPIRED", "报告已过期。");
    if (!job.report_available) return error(409, "REPORT_NOT_READY", "报告还没有生成。");
    const raw = await readFile(path.join(jobDir(jobRef), "report.json"), "utf8");
    return { status: 200, body: JSON.parse(raw) as CustomerReport };
  }

  async function artifact(jobRef: string, kind: string): Promise<{ status: number; body: Buffer; contentType: string; filename: string } | { status: number; body: unknown }> {
    if (kind !== "html" && kind !== "json") return error(404, "ARTIFACT_NOT_FOUND", "没有这种工件。");
    const job = await loadVisible(jobRef);
    if (!job) return error(404, "JOB_NOT_FOUND", "任务不存在。");
    if (job.state === "expired") return error(410, "EXPIRED", "报告已过期。");
    if (!job.report_available) return error(409, "REPORT_NOT_READY", "工件还没有生成。");
    try {
      const filename = kind === "html" ? "siteone.html" : "siteone.json";
      const body = await readFile(path.join(jobDir(jobRef), filename));
      return {
        status: 200,
        body,
        contentType: kind === "html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
        filename,
      };
    } catch {
      return error(404, "ARTIFACT_NOT_FOUND", "工件文件不存在。");
    }
  }

  async function cancel(jobRef: string): Promise<{ status: number; body: unknown }> {
    return lock(async () => {
      const job = await loadVisible(jobRef);
      if (!job) return error(404, "JOB_NOT_FOUND", "任务不存在。");
      if (job.state === "expired") return error(410, "EXPIRED", "报告已过期。");
      if (TERMINAL.has(job.state)) return { status: 200, body: toStatus(job) };
      aborts.get(jobRef)?.abort();
      const next = await update(jobRef, { state: "cancelled", reason_code: "CANCELLED", reason: "扫描已取消。", report_available: false });
      return { status: 202, body: toStatus(next) };
    });
  }

  async function loadVisible(jobRef: string): Promise<JobRecord | null> {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(jobRef)) return null;
    const job = await readJob(jobRef);
    if (!job) return null;
    if (job.state !== "expired" && Date.parse(job.expires_at) <= now().getTime()) {
      return update(jobRef, { state: "expired", report_available: false, reason_code: "EXPIRED", reason: "报告已过期。" });
    }
    return job;
  }

  async function hasActive(): Promise<boolean> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(jobsDir).catch(() => []);
    for (const name of names) {
      const job = await readJob(name);
      if (job && ACTIVE.has(job.state) && Date.parse(job.expires_at) > now().getTime()) return true;
    }
    return false;
  }

  async function findByIdempotency(key: string): Promise<JobRecord | null> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(jobsDir).catch(() => []);
    for (const name of names) {
      const job = await readJob(name);
      if (job?.idempotency_key === key) return job;
    }
    return null;
  }

  async function update(jobRef: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const current = await readJob(jobRef);
    if (!current) throw new Error(`missing job ${jobRef}`);
    if (current.state === "cancelled" && patch.state !== "cancelled") return current;
    const next = { ...current, ...patch, updated_at: now().toISOString() };
    await writeJob(next);
    return next;
  }

  function jobDir(jobRef: string): string {
    return path.join(jobsDir, jobRef);
  }

  async function readJob(jobRef: string): Promise<JobRecord | null> {
    try {
      const raw = await readFile(path.join(jobDir(jobRef), "job.json"), "utf8");
      return JSON.parse(raw) as JobRecord;
    } catch {
      return null;
    }
  }

  async function writeJob(job: JobRecord): Promise<void> {
    const dir = jobDir(job.job_ref);
    await mkdir(dir, { recursive: true });
    const temp = path.join(dir, `job.${randomBytes(4).toString("hex")}.tmp`);
    const finalPath = path.join(dir, "job.json");
    await writeFile(temp, JSON.stringify(job));
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await copyFile(temp, finalPath);
        await rm(temp, { force: true });
        return;
      } catch (error) {
        lastError = error;
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "EPERM" && code !== "EBUSY") break;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    await rm(temp, { force: true });
    throw lastError;
  }

  return { recover, create, get, report, artifact, cancel };
}

function toStatus(job: JobRecord): JobStatus {
  return {
    job_ref: job.job_ref,
    state: job.state,
    updated_at: job.updated_at,
    expires_at: job.expires_at,
    scope: job.scope,
    checked_pages: job.checked_pages,
    remaining_unknown: true,
    reason_code: job.reason_code,
    reason: job.reason,
    poll_after_seconds: ACTIVE.has(job.state) ? 2 : 0,
    report_available: job.report_available,
    target_host: job.target_host,
    synthetic: job.synthetic,
    report_language: "zh",
  };
}

function bodyHash(body: CreateJobBody): string {
  return createHash("sha256")
    .update(JSON.stringify({ url: body.url, language: body.language, text_hash: body.authorization.text_hash }))
    .digest("hex");
}

function error(status: number, code: string, message: string): { status: number; body: unknown } {
  return { status, body: { error: { code, message } } };
}

export type JobService = ReturnType<typeof createJobService>;
