import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTRACT_VERSION,
  ENGINE_VERSION,
  MAX_DEPTH,
  MAX_REQS_PER_SEC,
  MAX_URLS,
  RETENTION_DAYS,
  SITE_SUCCESS_WINDOW_MS,
  WALL_CLOCK_MS,
} from "../constants.ts";
import type { CreateJobBody } from "../http/request.ts";
import { PdfRenderError } from "../commercial/pdf.ts";
import { callCeilingFen, minimumCallCeilingFen, MODEL_TIMEOUT_MS } from "../commercial/qwen.ts";
import {
  type AdmissionIdentity,
  type BudgetCaps,
  budgetFit,
  DEFAULT_BUDGET,
  canonicalHost,
  decideAdmission,
  loadLedger,
  rawHost,
  reserveAdmission,
  saveLedger,
  syncAdmission,
  type Ledger,
} from "./admission.ts";
import { produceCommercial, type Analyzer } from "../commercial/stage.ts";
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
  model_authorized: boolean;
  customer_report_available: boolean;
  customer_report_reason: string | null;
  customer_report_revision: string | null;
  pdf_available: boolean;
  pdf_reason: string | null;
  engine_version: typeof ENGINE_VERSION;
  canonical_host?: string;
  admission_browser?: string;
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
  customer_report_available: boolean;
  customer_report_reason: string | null;
  customer_report_revision: string | null;
  commercial_contract_version: "vfdiag.commercial-report.v1" | null;
  pdf_available: boolean;
  pdf_reason: string | null;
  target_host: string | null;
  synthetic: boolean;
  report_language: "zh";
};

export type PdfRenderer = (input: { jobRef: string; revision: string; signal: AbortSignal }) => Promise<Buffer>;

type Runner = (options: {
  target: ResolvedTarget;
  jsonFile: string;
  htmlFile: string;
  signal: AbortSignal;
}) => Promise<CrawlResult>;

type ChargeSnapshot = {
  requestSent: boolean;
  costCny: number | null;
  connectionFailure: boolean;
  at: string | null;
  ceilingFen: number | null;
};

const ACTIVE = new Set<JobState>(["queued", "validating", "running", "summarizing"]);
const TERMINAL = new Set<JobState>(["complete", "partial", "failed", "cancelled", "expired"]);

export function createJobService(options: {
  dataDir: string;
  lookup: Lookup;
  syntheticHosts: ReadonlySet<string>;
  run: Runner;
  now?: () => Date;
  analyze?: Analyzer;
  renderPdf?: PdfRenderer;
  budgets?: BudgetCaps;
}) {
  const now = options.now ?? (() => new Date());
  const budgets = options.budgets ?? DEFAULT_BUDGET;
  const jobsDir = path.join(options.dataDir, "jobs");
  const ledgerFile = path.join(options.dataDir, "admission.json");
  const aborts = new Map<string, AbortController>();
  let chain: Promise<unknown> = Promise.resolve();
  const lockContext = new AsyncLocalStorage<true>();

  function lock<T>(fn: () => Promise<T>): Promise<T> {
    if (lockContext.getStore()) return fn();
    const run = chain.then(() => lockContext.run(true, fn));
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
    const snaps = new Map<string, ChargeSnapshot>();
    for (const name of names) snaps.set(name, await readChargeSnapshot(name));
    for (const name of names) {
      const job = await readJob(name);
      if (!job) continue;
      if (Date.parse(job.expires_at) <= now().getTime()) {
        await expire(job);
        continue;
      }
      if ((job.state === "complete" || job.state === "partial") && job.pdf_reason === "PDF_PENDING" && job.customer_report_revision) {
        const revision = job.customer_report_revision;
        queueMicrotask(() => {
          void storePdf(job.job_ref, jobDir(job.job_ref), revision, AbortSignal.timeout(120_000));
        });
      }
      if (ACTIVE.has(job.state)) {
        if (job.state === "summarizing" && (await readFile(path.join(jobDir(job.job_ref), "report.json"), "utf8").catch(() => null))) {
          const controller = new AbortController();
          aborts.set(job.job_ref, controller);
          queueMicrotask(() => {
            void continueCommercial(job.job_ref, controller).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : "任务执行失败。";
              return update(job.job_ref, { state: "failed", reason_code: "ENGINE_FAILED", reason: message, report_available: false }).catch(() => undefined);
            });
          });
          continue;
        }
        await update(job.job_ref, {
          state: "failed",
          report_available: false,
          reason_code: "WORKER_RESTARTED",
          reason: "Worker 重启前任务未结束，本次没有沿用中断的扫描。",
        });
      }
    }
    await lock(() => importHistorical(snaps));
  }

  async function create(body: CreateJobBody, admission?: AdmissionIdentity | null): Promise<{ status: number; body: unknown }> {
    return lock(async () => {
      const existing = await findByIdempotency(body.idempotency_key);
      const hash = bodyHash(body);
      if (existing) {
        if (existing.body_hash !== hash || (admission && existing.admission_browser !== admission.browser)) {
          return error(409, "IDEMPOTENCY_CONFLICT", "同一个幂等键对应了不同的请求。");
        }
        return { status: 200, body: toStatus(existing) };
      }
      const paid = body.model_authorized === true && !isSyntheticUrl(body.url);
      const host = canonicalHost(body.url);
      let ledger: Ledger | null = null;
      if (paid && admission !== undefined) {
        if (!host) return error(400, "TARGET_URL_INVALID", "网址无法解析。只接受完整的 http 或 https 网址。");
        if (!admission) return error(400, "ADMISSION_REQUIRED", "付费诊断需要当日的浏览器和网络标识。");
        ledger = await currentLedger();
        const decision = decideAdmission(ledger, { now: now(), host, browser: admission.browser, ip: admission.ip }, budgets, minimumCallCeilingFen());
        if (!decision.ok) return error(decision.status, decision.code, decision.message);
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
        model_authorized: body.model_authorized === true,
        customer_report_available: false,
        customer_report_reason: null,
        customer_report_revision: null,
        pdf_available: false,
        pdf_reason: null,
        engine_version: ENGINE_VERSION,
        ...(host ? { canonical_host: host } : {}),
        ...(admission ? { admission_browser: admission.browser } : {}),
      };
      if (paid && ledger && host && admission) {
        await saveLedger(ledgerFile, reserveAdmission(ledger, { now: now(), host, browser: admission.browser, ip: admission.ip, jobRef: job.job_ref }));
      }
      await writeJob(job);
      const controller = new AbortController();
      aborts.set(job.job_ref, controller);
      lockContext.exit(() => {
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
    if (noWorkingResponse(parsed)) {
      await update(jobRef, {
        state: "failed",
        reason_code: "TARGET_UNREACHABLE",
        reason: "目标网站没有连上，报告未发布。",
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
    await writeFile(path.join(dir, "scan-meta.json"), JSON.stringify({ exitCode: result.exitCode, checked_pages: projected.report.coverage.scanned_pages }));
    await finishCommercial(jobRef, dir, parsed, result.jsonText, result.html ? result.html.toString("utf8") : null, verdict.target.host, controller);
  }

  async function continueCommercial(jobRef: string, controller: AbortController): Promise<void> {
    const dir = jobDir(jobRef);
    let parsed: SiteOneJson;
    try {
      parsed = JSON.parse(await readFile(path.join(dir, "siteone.json"), "utf8")) as SiteOneJson;
    } catch {
      await update(jobRef, { state: "failed", reason_code: "WORKER_RESTARTED", reason: "Worker 重启前扫描结果不完整，本次没有沿用。", report_available: false });
      aborts.delete(jobRef);
      return;
    }
    const host = (await readJob(jobRef))?.target_host;
    if (!host) {
      await update(jobRef, { state: "failed", reason_code: "WORKER_RESTARTED", reason: "Worker 重启前任务未记录目标域名。", report_available: false });
      aborts.delete(jobRef);
      return;
    }
    const jsonText = await readFile(path.join(dir, "siteone.json"), "utf8");
    const html = await readFile(path.join(dir, "siteone.html"), "utf8").catch(() => null);
    await finishCommercial(jobRef, dir, parsed, jsonText, html, host, controller);
  }

  async function finishCommercial(
    jobRef: string,
    dir: string,
    parsed: SiteOneJson,
    jsonText: string,
    html: string | null,
    host: string,
    controller: AbortController,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, timeout]);
    try {
      const currentJob = await readJob(jobRef);
      const priorModel = currentJob?.canonical_host ? (await currentLedger()).sites[currentJob.canonical_host] : undefined;
      const modelAlreadyUsed = Boolean(priorModel?.model_job && priorModel.model_job !== jobRef && priorModel.model_at && now().getTime() - Date.parse(priorModel.model_at) < SITE_SUCCESS_WINDOW_MS);
      const blocked = currentJob?.synthetic && currentJob.model_authorized
        ? { code: "COMMERCIAL_SYNTHETIC", message: "合成测试不调用付费模型。" }
        : modelAlreadyUsed
          ? { code: "MODEL_INTERRUPTED", message: "同一网站已经发起过模型调用，为避免重复付费，没有再次调用。" }
          : currentJob?.model_authorized
            ? undefined
            : { code: "MODEL_NOT_AUTHORIZED", message: "这次授权只覆盖公开页面扫描，不能据此调用模型。" };
      const budgetHost = currentJob?.canonical_host ?? canonicalHost(currentJob?.target_url ?? "") ?? host;
      await produceCommercial({
        dir,
        siteone: parsed,
        siteoneText: jsonText,
        html,
        host,
        jobRef,
        synthetic: currentJob?.synthetic === true,
        generatedAt: now().toISOString(),
        signal,
        analyze: blocked ? undefined : options.analyze,
        blocked,
        afford: blocked || !currentJob?.model_authorized ? undefined : (ceilingFen) => holdModelCeiling(budgetHost, jobRef, ceilingFen),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        await update(jobRef, { state: "cancelled", reason_code: "CANCELLED", reason: "扫描已取消。", report_available: false });
        aborts.delete(jobRef);
        return;
      }
      if (timeout.aborted) {
        await writeFile(path.join(dir, "commercial-error.json"), JSON.stringify({ code: "MODEL_TIMEOUT", message: "模型调用超时，技术报告已保留，商业报告未生成。" }));
      } else {
        const message = error instanceof Error ? error.message : "商业报告阶段失败。";
        await writeFile(path.join(dir, "commercial-error.json"), JSON.stringify({ code: "MODEL_FAILED", message }));
      }
    }
    if (controller.signal.aborted) {
      await update(jobRef, { state: "cancelled", reason_code: "CANCELLED", reason: "扫描已取消。", report_available: false });
      aborts.delete(jobRef);
      return;
    }
    const meta = JSON.parse(await readFile(path.join(dir, "scan-meta.json"), "utf8").catch(() => "{}")) as { exitCode?: number | null; checked_pages?: number };
    const early = meta.exitCode !== 0 && meta.exitCode !== undefined && meta.exitCode !== null;
    const commercial = await readCommercial(dir);
    await update(jobRef, {
      state: early ? "partial" : "complete",
      checked_pages: typeof meta.checked_pages === "number" ? meta.checked_pages : null,
      report_available: true,
      reason_code: early ? "ENGINE_EXIT_NONZERO" : null,
      reason: early ? "扫描进程非正常结束，报告只覆盖已经写下的结果。" : null,
      customer_report_available: commercial.available,
      customer_report_reason: commercial.reason,
      customer_report_revision: commercial.revision,
      pdf_available: false,
      pdf_reason: commercial.available ? (options.renderPdf ? "PDF_PENDING" : "PDF_NOT_CONFIGURED") : null,
    });
    aborts.delete(jobRef);
    if (commercial.available && commercial.revision && options.renderPdf) {
      await storePdf(jobRef, dir, commercial.revision, AbortSignal.timeout(120_000));
    }
  }

  async function storePdf(jobRef: string, dir: string, revision: string, signal: AbortSignal): Promise<void> {
    if (!options.renderPdf) {
      await update(jobRef, { pdf_available: false, pdf_reason: "PDF_NOT_CONFIGURED" });
      return;
    }
    try {
      const bytes = await options.renderPdf({ jobRef, revision, signal });
      await writeFile(path.join(dir, "commercial.pdf"), bytes);
      await writeFile(path.join(dir, "commercial.pdf.revision"), revision);
      await update(jobRef, { pdf_available: true, pdf_reason: null });
    } catch (error) {
      const code = error instanceof PdfRenderError ? error.code : "PDF_FAILED";
      const detail = error instanceof Error ? error.message : "PDF 生成失败。";
      console.log(`pdf ${code} ${detail}`);
      await update(jobRef, { pdf_available: false, pdf_reason: code });
    }
  }

  async function readCommercial(dir: string): Promise<{ available: boolean; reason: string | null; revision: string | null }> {
    const ready = await readFile(path.join(dir, "commercial-report.json"), "utf8").catch(() => null);
    if (ready) {
      const body = JSON.parse(ready) as { revision?: unknown };
      return { available: true, reason: null, revision: typeof body.revision === "string" ? body.revision : null };
    }
    const failed = await readFile(path.join(dir, "commercial-error.json"), "utf8").catch(() => null);
    if (!failed) return { available: false, reason: "COMMERCIAL_NOT_READY", revision: null };
    const body = JSON.parse(failed) as { code?: unknown };
    return { available: false, reason: typeof body.code === "string" ? body.code : "COMMERCIAL_NOT_READY", revision: null };
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

  async function commercialReport(jobRef: string, revision?: string | null): Promise<{ status: number; body: unknown }> {
    const job = await loadVisible(jobRef);
    if (!job) return error(404, "JOB_NOT_FOUND", "任务不存在。");
    if (job.state === "cancelled") return error(409, "CANCELLED", "任务已取消，商业报告不交付。");
    if (job.state === "expired") return error(410, "EXPIRED", "报告已过期。");
    const dir = jobDir(jobRef);
    const ready = await readFile(path.join(dir, "commercial-report.json"), "utf8").catch(() => null);
    if (ready) {
      const body = JSON.parse(ready) as { revision?: unknown };
      if (revision && body.revision !== revision) return error(409, "REVISION_MISMATCH", "请求的报告版本与已发布版本不一致。");
      return { status: 200, body };
    }
    if (ACTIVE.has(job.state)) return error(409, "COMMERCIAL_PENDING", "商业报告还在生成。");
    const failed = await readFile(path.join(dir, "commercial-error.json"), "utf8").catch(() => null);
    if (failed) {
      const body = JSON.parse(failed) as { code?: string; message?: string };
      return error(409, body.code ?? "COMMERCIAL_NOT_READY", body.message ?? "商业报告没有生成。");
    }
    return error(409, "COMMERCIAL_NOT_READY", "商业报告没有生成。");
  }

  async function retryPdf(jobRef: string): Promise<{ status: number; body: unknown }> {
    const job = await loadVisible(jobRef);
    if (!job) return error(404, "JOB_NOT_FOUND", "任务不存在。");
    if (job.state === "cancelled") return error(409, "CANCELLED", "任务已取消，不能生成 PDF。");
    if (job.state === "expired") return error(410, "EXPIRED", "报告已过期。");
    if (!job.customer_report_available || !job.customer_report_revision) {
      return error(409, "COMMERCIAL_NOT_READY", "在线商业报告还没有发布，不能生成 PDF。");
    }
    if (job.pdf_available) return { status: 200, body: toStatus(job) };
    await update(jobRef, { pdf_reason: options.renderPdf ? "PDF_PENDING" : "PDF_NOT_CONFIGURED", pdf_available: false });
    await storePdf(jobRef, jobDir(jobRef), job.customer_report_revision, AbortSignal.timeout(120_000));
    const latest = await readJob(jobRef);
    return { status: 200, body: toStatus(latest ?? job) };
  }

  async function artifact(jobRef: string, kind: string, revision?: string | null): Promise<{ status: number; body: Buffer; contentType: string; filename: string } | { status: number; body: unknown }> {
    if (kind !== "html" && kind !== "json" && kind !== "pdf") return error(404, "ARTIFACT_NOT_FOUND", "没有这种工件。");
    const job = await loadVisible(jobRef);
    if (!job) return error(404, "JOB_NOT_FOUND", "任务不存在。");
    if (job.state === "cancelled") return error(409, "CANCELLED", "任务已取消，工件不交付。");
    if (job.state === "expired") return error(410, "EXPIRED", "报告已过期。");
    if (kind === "pdf") {
      if (!job.pdf_available) return error(409, job.pdf_reason ?? "PDF_NOT_READY", "PDF 还没有生成。");
      const stored = await readFile(path.join(jobDir(jobRef), "commercial.pdf.revision"), "utf8").catch(() => "");
      if (revision && revision !== stored.trim()) return error(409, "REVISION_MISMATCH", "请求的 PDF 版本与已保存版本不一致。");
      try {
        const body = await readFile(path.join(jobDir(jobRef), "commercial.pdf"));
        return { status: 200, body, contentType: "application/pdf", filename: "commercial.pdf", revision: stored.trim() };
      } catch {
        return error(404, "ARTIFACT_NOT_FOUND", "PDF 文件不存在。");
      }
    }
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
      const next = await update(jobRef, {
        state: "cancelled",
        reason_code: "CANCELLED",
        reason: "扫描已取消。",
        report_available: false,
        customer_report_available: false,
        customer_report_reason: "CANCELLED",
        pdf_available: false,
        pdf_reason: "CANCELLED",
      });
      return { status: 202, body: toStatus(next) };
    });
  }

  async function loadVisible(jobRef: string): Promise<JobRecord | null> {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(jobRef)) return null;
    const job = await readJob(jobRef);
    if (!job) return null;
    if (Date.parse(job.expires_at) <= now().getTime()) return expire(job);
    return job;
  }

  async function expire(job: JobRecord): Promise<JobRecord> {
    await purgeArtifacts(job.job_ref);
    if (job.state === "expired" && !job.report_available) return job;
    return update(job.job_ref, {
      state: "expired",
      report_available: false,
      reason_code: "EXPIRED",
      reason: "报告已过期。",
    });
  }

  async function purgeArtifacts(jobRef: string): Promise<void> {
    const dir = jobDir(jobRef);
    await Promise.all(
      ["siteone.html", "siteone.json", "report.json", "scan-meta.json", "analysis.json", "commercial-report.json", "commercial-receipt.json", "commercial-error.json", "commercial.pdf", "commercial.pdf.revision"].map((name) => rm(path.join(dir, name), { force: true })),
    );
  }

  function isSyntheticUrl(input: string): boolean {
    const names = [rawHost(input), canonicalHost(input)];
    return names.some((name) => name !== null && options.syntheticHosts.has(name));
  }

  async function currentLedger(): Promise<Ledger> {
    const ledger = await loadLedger(ledgerFile);
    let dirty = false;
    for (const site of Object.values(ledger.sites)) {
      if (!site.active_job) continue;
      const job = await readJob(site.active_job);
      if (!job || !ACTIVE.has(job.state) || Date.parse(job.expires_at) <= now().getTime()) {
        site.active_job = null;
        dirty = true;
      }
    }
    if (dirty) await saveLedger(ledgerFile, ledger);
    return ledger;
  }

  async function syncJob(job: JobRecord): Promise<void> {
    const host = job.canonical_host ?? canonicalHost(job.target_url);
    if (!host || !job.model_authorized || isSyntheticUrl(job.target_url)) return;
    const snap = await readChargeSnapshot(job.job_ref);
    const expired = Date.parse(job.expires_at) <= now().getTime();
    const settled = expired || !ACTIVE.has(job.state);
    const synced = syncAdmission(await currentLedger(), {
      now: now(),
      host,
      jobRef: job.job_ref,
      at: snap.at ?? job.updated_at,
      active: !settled,
      success: job.customer_report_available === true && !expired,
      settled,
      requestSent: snap.requestSent,
      connectionFailure: snap.connectionFailure,
      costCny: snap.costCny,
      ceilingFen: snap.ceilingFen,
    });
    await saveLedger(ledgerFile, synced.ledger);
  }

  async function holdModelCeiling(host: string, jobRef: string, ceilingFen: number): Promise<{ ok: true } | { ok: false; message: string }> {
    return lock(async () => {
      const ledger = await currentLedger();
      const fit = budgetFit(ledger, { now: now(), host }, budgets, ceilingFen);
      if (!fit.ok) return { ok: false, message: fit.message };
      const synced = syncAdmission(ledger, {
        now: now(),
        host,
        jobRef,
        at: now().toISOString(),
        active: true,
        success: false,
        settled: false,
        requestSent: true,
        connectionFailure: false,
        costCny: null,
        ceilingFen,
      });
      await saveLedger(ledgerFile, synced.ledger);
      return { ok: true };
    });
  }

  async function importHistorical(snaps: Map<string, ChargeSnapshot>): Promise<void> {
    let ledger = await currentLedger();
    for (const [jobRef, snap] of snaps) {
      const job = await readJob(jobRef);
      if (!job || job.synthetic || isSyntheticUrl(job.target_url)) continue;
      if (!job.model_authorized && !snap.requestSent && job.customer_report_available !== true) continue;
      const host = job.canonical_host ?? canonicalHost(job.target_url);
      if (!host) continue;
      const expired = Date.parse(job.expires_at) <= now().getTime();
      const settled = expired || !ACTIVE.has(job.state);
      ledger = syncAdmission(ledger, {
        now: now(),
        host,
        jobRef,
        at: snap.at ?? job.updated_at,
        active: !settled,
        success: job.customer_report_available === true && !expired,
        settled,
        requestSent: snap.requestSent,
        connectionFailure: snap.connectionFailure,
        costCny: snap.costCny,
        ceilingFen: snap.ceilingFen,
      }).ledger;
    }
    await saveLedger(ledgerFile, ledger);
  }

  async function readChargeSnapshot(jobRef: string): Promise<ChargeSnapshot> {
    const dir = jobDir(jobRef);
    const receipt = await readFile(path.join(dir, "commercial-receipt.json"), "utf8").then((raw) => JSON.parse(raw) as { request_sent?: unknown; code?: unknown; ceiling_fen?: unknown; model_receipt?: { estimated_cost_cny?: unknown } }).catch(() => null);
    const error = await readFile(path.join(dir, "commercial-error.json"), "utf8").then((raw) => JSON.parse(raw) as { code?: unknown; message?: unknown }).catch(() => null);
    const report = await readFile(path.join(dir, "commercial-report.json"), "utf8").then((raw) => JSON.parse(raw) as { generated_at?: unknown }).catch(() => null);
    const message = typeof error?.message === "string" ? error.message : "";
    const code = typeof receipt?.code === "string" ? receipt.code : typeof error?.code === "string" ? error.code : "";
    const cost = receipt?.model_receipt?.estimated_cost_cny;
    const requestSent = receipt?.request_sent === true;
    const connectionFailure = code === "MODEL_FAILED" && (message === "fetch failed" || message.startsWith("模型连接中断"));
    let ceilingFen = typeof receipt?.ceiling_fen === "number" ? receipt.ceiling_fen : null;
    if (ceilingFen === null && requestSent && typeof cost !== "number" && !connectionFailure) {
      const siteone = await readFile(path.join(dir, "siteone.json"), "utf8").then((raw) => JSON.parse(raw) as SiteOneJson).catch(() => null);
      if (siteone) {
        const html = await readFile(path.join(dir, "siteone.html"), "utf8").catch(() => null);
        const { cleanSiteOne } = await import("../commercial/clean.ts");
        ceilingFen = callCeilingFen(cleanSiteOne(siteone, html));
      }
    }
    return {
      requestSent,
      costCny: typeof cost === "number" ? cost : null,
      connectionFailure,
      at: typeof report?.generated_at === "string" ? report.generated_at : null,
      ceilingFen,
    };
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
    return lock(() => updateUnlocked(jobRef, patch));
  }

  async function updateUnlocked(jobRef: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const current = await readJob(jobRef);
    if (!current) throw new Error(`missing job ${jobRef}`);
    if (current.state === "cancelled" && patch.state !== "cancelled" && patch.state !== "expired") return current;
    const next = { ...current, ...patch, updated_at: now().toISOString() };
    if (next.model_authorized && !isSyntheticUrl(next.target_url)) await syncJob(next);
    await writeJob(next);
    return next;
  }

  function jobDir(jobRef: string): string {
    return path.join(jobsDir, jobRef);
  }

  async function readJob(jobRef: string): Promise<JobRecord | null> {
    const file = path.join(jobDir(jobRef), "job.json");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const raw = await readFile(file, "utf8");
        if (!raw.trim()) throw new SyntaxError("empty job");
        return JSON.parse(raw) as JobRecord;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code === "ENOENT") return null;
        if (attempt === 7) return null;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    return null;
  }

  async function writeJob(job: JobRecord): Promise<void> {
    const dir = jobDir(job.job_ref);
    await mkdir(dir, { recursive: true });
    const temp = path.join(dir, `job.${randomBytes(4).toString("hex")}.tmp`);
    const finalPath = path.join(dir, "job.json");
    await writeFile(temp, JSON.stringify(job));
    try {
      await rename(temp, finalPath);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EEXIST") {
        await rm(temp, { force: true });
        throw error;
      }
    }
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

  return { recover, create, get, report, commercialReport, retryPdf, artifact, cancel };
}

export function noWorkingResponse(siteone: SiteOneJson): boolean {
  const rows = (siteone.results ?? []).filter((row) => {
    const url = typeof row.url === "string" ? row.url : "";
    return url.startsWith("http://") || url.startsWith("https://");
  });
  if (rows.length === 0) return true;
  return rows.every((row) => {
    const status = typeof row.status === "string" ? row.status : "";
    return status.startsWith("-1") || status.includes("CONN-FAIL");
  });
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
    customer_report_available: job.customer_report_available === true,
    customer_report_reason: job.customer_report_reason ?? null,
    customer_report_revision: job.customer_report_revision ?? null,
    commercial_contract_version: job.customer_report_available === true ? "vfdiag.commercial-report.v1" : null,
    pdf_available: job.pdf_available === true,
    pdf_reason: job.pdf_reason ?? null,
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
