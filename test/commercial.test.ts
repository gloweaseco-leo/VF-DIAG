import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanHtmlReport } from "../src/commercial/clean.ts";
import { composeCommercialReport } from "../src/commercial/compose.ts";
import { fetchPrintPdf, PdfRenderError } from "../src/commercial/pdf.ts";
import { callQwen, ModelCallError, qwenEndpoint, buildQwenPayload } from "../src/commercial/qwen.ts";
import { deriveScoreScale } from "../src/commercial/score-scale.ts";
import { produceCommercial } from "../src/commercial/stage.ts";
import { MODEL_AUTHORIZATION_VERSION } from "../src/constants.ts";
import { authorizationTextHash, modelAuthorizationTextHash } from "../src/http/request.ts";
import { createJobService } from "../src/jobs/service.ts";
import { crawlerEnvironment } from "../src/siteone/process.ts";
import type { CrawlResult } from "../src/siteone/run.ts";

const replayPath = new URL("../fixtures/replay/jjg-v03.analysis.json", import.meta.url);

test("score graphics agree on a full score of 10", () => {
  const bars = ["Performance", "SEO", "Security", "Accessibility", "Best Practices"]
    .map((name) => `<span class="qs-cat-name">${name}</span><div style="width:57%"></div><span style="text-align:right;">5.7</span>`)
    .join("");
  const html = `<div class="qs-box"><div class="qs-bar-track" style="background:conic-gradient(#eab308 0deg 205.2deg, transparent 205.2deg 360deg)"><div class="qs-donut-inner"><span>5.7</span></div></div>${bars}</div>`;
  const scale = deriveScoreScale(html);
  assert.equal(scale.status, "DETERMINED");
  assert.equal(scale.max_score, 10);
  const conflict = deriveScoreScale(html.replace("width:57%", "width:50%"));
  assert.equal(conflict.status, "CONFLICT");
  assert.equal(conflict.max_score, null);
});

test("offline replay builds a customer report without a scan or a model call", async () => {
  const analysis = JSON.parse(await readFile(replayPath, "utf8")) as { source_profile: { target_domain: string; checked_urls: number }; diagnosis: { verdict: string }; risk_review: { manual_review_needed: boolean } };
  const composed = composeCommercialReport({ analysis, generatedAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  const report = composed.report;
  assert.equal(report.contract_version, "vfdiag.commercial-report.v1");
  assert.equal(report.subject.domain, analysis.source_profile.target_domain);
  assert.equal(report.subject.checked_urls, analysis.source_profile.checked_urls);
  assert.equal(report.overview.verdict, analysis.diagnosis.verdict);
  assert.equal(report.subject.limited, false);
  assert.equal(report.delivery.pdf.status, "PENDING_VEYFRONT_PRINT");
  assert.equal(report.technical_appendix.is_business_score, false);
  assert.equal(JSON.stringify(report).includes("manual_review"), false);
  assert.equal(JSON.stringify(report).includes("SiteOne"), false);
  const ids = new Set(report.evidence.map((item) => item.id));
  for (const chapter of report.chapters) {
    for (const finding of chapter.findings) {
      assert.ok(finding.evidence_ids.every((id) => ids.has(id)));
    }
  }
  assert.ok(report.chapters.some((chapter) => chapter.findings.length > 0));
  const source = await readFile(new URL("../src/commercial/compose.ts", import.meta.url), "utf8");
  assert.equal(/jjg|剑桥|SQV/i.test(source), false);
  const other = structuredClone(analysis) as typeof analysis & { diagnosis: { headline: string }; source_profile: { target_domain: string } };
  other.source_profile.target_domain = "other.example";
  other.diagnosis.headline = "示例工厂已有产品页。";
  const shifted = composeCommercialReport({ analysis: other, generatedAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(shifted.ok, true);
  if (!shifted.ok) return;
  assert.equal(shifted.report.subject.domain, "other.example");
  assert.equal(shifted.report.overview.headline.includes("示例工厂"), true);
  const fresh = composeCommercialReport({ analysis: sample("other.example"), generatedAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(fresh.ok, true);
  if (!fresh.ok) return;
  assert.equal(JSON.stringify(fresh.report).includes("jjgamemachine"), false);
  const saved = await readFile(new URL("../contracts/examples/commercial-report.jjg-replay.json", import.meta.url), "utf8");
  assert.equal(saved, JSON.stringify(report, null, 2));
});

test("thin evidence narrows the conclusion instead of waiting for a person", () => {
  const analysis = sample("partial.example");
  analysis.source_profile.data_sufficiency = "unusable";
  analysis.diagnosis.verdict = "site_rebuild_assessment";
  analysis.risk_review.manual_review_needed = true;
  const composed = composeCommercialReport({ analysis, generatedAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  assert.equal(composed.report.subject.limited, true);
  assert.equal(composed.report.overview.verdict, "further_verification");
  assert.equal(composed.report.next_step.choices.length, 0);
  assert.equal(JSON.stringify(composed.report).includes("manual_review"), false);
});

test("findings with missing evidence or invented business results are left out", () => {
  const dangling = sample("factory.example");
  dangling.diagnosis.priority_findings[0].evidence_ids = ["E99"];
  const droppedRef = composeCommercialReport({ analysis: dangling, generatedAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(droppedRef.ok, true);
  if (!droppedRef.ok) return;
  assert.equal(droppedRef.report.chapters.every((chapter) => chapter.findings.length === 0), true);
  assert.ok(droppedRef.dropped.length > 0);

  const invented = sample("factory.example");
  invented.diagnosis.priority_findings[0].observed_fact = "搜索排名第一，询盘量已经翻倍。";
  const droppedClaim = composeCommercialReport({ analysis: invented, generatedAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(droppedClaim.ok, true);
  if (!droppedClaim.ok) return;
  assert.equal(droppedClaim.report.chapters.every((chapter) => chapter.findings.length === 0), true);

  const empty = sample("factory.example");
  empty.diagnosis.priority_findings[0].evidence_ids = [];
  const droppedEmpty = composeCommercialReport({ analysis: empty, generatedAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(droppedEmpty.ok, true);
  if (!droppedEmpty.ok) return;
  assert.equal(droppedEmpty.report.chapters.every((chapter) => chapter.findings.length === 0), true);

  const mixed = sample("factory.example");
  mixed.diagnosis.priority_findings[0].observed_fact = "不代表搜索排名。搜索排名第一，询盘量翻倍。";
  const keptDisclaimer = composeCommercialReport({ analysis: mixed, generatedAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(keptDisclaimer.ok, true);
  if (!keptDisclaimer.ok) return;
  const mixedText = JSON.stringify(keptDisclaimer.report.chapters);
  assert.equal(mixedText.includes("不代表搜索排名"), true);
  assert.equal(mixedText.includes("询盘量翻倍"), false);
});

test("a dropped finding leaves the first screen without blocking an evidenced rebuild", () => {
  const analysis = sample("factory.example");
  analysis.diagnosis.verdict = "site_rebuild_assessment";
  analysis.diagnosis.verdict_evidence_ids = ["E01"];
  analysis.diagnosis.headline = "产品页可以打开。虚假排名结论需要整站重建。";
  analysis.diagnosis.verdict_reason = "虚假排名结论说明现有结构不够用。产品页可以打开。";
  analysis.diagnosis.priority_findings.push({
    id: "F02",
    priority: "P1",
    business_area: "product_discoverability",
    title: "虚假排名结论",
    observed_fact: "搜索排名第一。",
    possible_business_effect: "询盘量翻倍。",
    recommended_action: "重做整站。",
    acceptance_checks: [],
    needs_confirmation: [],
    evidence_ids: [],
    effect_level: "INFERRED",
  });
  const composed = composeCommercialReport({ analysis, generatedAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  assert.equal(composed.report.overview.verdict, "site_rebuild_assessment");
  assert.equal(composed.report.overview.headline.includes("虚假排名结论"), false);
  assert.equal(composed.report.overview.verdict_reason.includes("虚假排名结论"), false);
  assert.equal(composed.report.overview.headline.includes("产品页可以打开"), true);
  assert.equal(JSON.stringify(composed.report.chapters).includes("虚假排名结论"), false);
});

test("verified HTML tables keep contact, product, and date evidence", () => {
  const html = `
    <html><head><title>剑桥样本</title></head><body>
    <table class="table non-clickable-phone-numbers">
      <thead><tr><th data-label="Value">Value</th><th data-label="Occurs">Occurs</th></tr></thead>
      <tbody><tr><td data-value="+86 130 7679 8682">masked</td><td data-value="37">37</td></tr></tbody>
    </table>
    <table class="table seo-headings">
      <thead><tr><th data-label="URL">URL</th><th data-label="Headings">Headings</th></tr></thead>
      <tbody><tr><td data-value="https://jjgamemachine.com/case/arcade">case</td><td>Claw Machine April 2017</td></tr></tbody>
    </table>
    </body></html>`;
  const clean = cleanHtmlReport(html);
  assert.match(clean, /SITEONE_HTML_CLEAN_START/);
  assert.match(clean, /\+86 130 7679 8682/);
  assert.match(clean, /Claw Machine April 2017/);
  assert.match(clean, /https:\/\/jjgamemachine.com\/case\/arcade/);
  assert.match(clean, /TABLE non-clickable-phone-numbers rows=1/);
});

test("the crawler process does not receive model or service credentials", () => {
  const env = crawlerEnvironment({
    PATH: "C:\\Windows\\System32",
    HOME: "C:\\Users\\worker",
    VFDIAG_QWEN_API_KEY: "secret-model",
    VFDIAG_SERVICE_TOKEN: "secret-service",
    VFDIAG_RENDER_TOKEN: "secret-render",
  });
  assert.equal(env.PATH, "C:\\Windows\\System32");
  assert.equal(env.HOME, "C:\\Users\\worker");
  assert.equal("VFDIAG_QWEN_API_KEY" in env, false);
  assert.equal("VFDIAG_SERVICE_TOKEN" in env, false);
  assert.equal("VFDIAG_RENDER_TOKEN" in env, false);
});

test("print delivery accepts only the VF PDF response", async () => {
  const pdf = Buffer.from("%PDF-1.4\n");
  const bytes = await fetchPrintPdf({
    origin: "https://print.example",
    token: "render-token-at-least-32-characters",
    jobRef: "job-ref-01",
    revision: "abc",
    signal: AbortSignal.timeout(1000),
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://print.example/website-diagnosis/print");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-vf-job-ref"), "job-ref-01");
      assert.equal(headers.get("x-vf-report-revision"), "abc");
      return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
    },
  });
  assert.equal(bytes.subarray(0, 5).toString("utf8"), "%PDF-");
  const printed = await fetchPrintPdf({
    origin: "https://print.example",
    token: "render-token-at-least-32-characters",
    jobRef: "job-ref-01",
    revision: "abc",
    signal: AbortSignal.timeout(1000),
    fetchImpl: async () => new Response("<html><head></head><body>打印</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    printHtml: async (html) => {
      assert.match(html, /<base href="https:\/\/print\.example\/">/);
      assert.match(html, /打印/);
      return Buffer.from("%PDF-1.4\n");
    },
  });
  assert.equal(printed.subarray(0, 5).toString("utf8"), "%PDF-");
  await assert.rejects(
    () => fetchPrintPdf({
      origin: "http://print.example",
      token: "render-token-at-least-32-characters",
      jobRef: "job-ref-01",
      revision: "abc",
      signal: AbortSignal.timeout(1000),
      fetchImpl: async () => new Response(pdf),
    }),
    (error: unknown) => error instanceof PdfRenderError && error.code === "PDF_RENDER_FAILED",
  );
});

test("the model request matches the verified Qwen4-Max V0.3 call", () => {
  assert.throws(() => qwenEndpoint("http://example.com/compatible-mode/v1"), ModelCallError);
  assert.equal(qwenEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"), "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  const built = buildQwenPayload("clean source");
  assert.equal(built.skill_sha256, "fdbd40f4230e219c2283c6951e75b65b4ca04ff014ee724b82febfb81c608b40");
  assert.equal(built.payload.model, "qwen4-max");
  assert.equal(built.payload.thinking_budget, 30720);
  assert.equal(built.payload.max_completion_tokens, 45056);
  assert.equal(built.payload.enable_search, false);
  assert.equal("reasoning_effort" in built.payload, false);
  const messages = built.payload.messages as Array<{ content: string }>;
  const joined = messages.map((item) => item.content).join("\n");
  assert.match(joined, /SKILL_blind_v0\.3\.md/);
  assert.equal(joined.includes("SKILL_blind_v0.1.md"), false);
  assert.equal(joined.includes("jjgamemachine.gold"), false);
  assert.equal(joined.includes("DATA_SLOT_START\nclean source\nDATA_SLOT_END"), true);
});

test("a failed model response is not retried", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("no", { status: 500 });
  };
  await assert.rejects(
    () => callQwen({ cleanText: "x", apiKey: "test-key", signal: AbortSignal.timeout(1000), fetchImpl }),
    (error: unknown) => error instanceof ModelCallError && error.code === "MODEL_HTTP",
  );
  assert.equal(calls, 1);
  const incomplete: typeof fetch = async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] });
  await assert.rejects(
    () => callQwen({ cleanText: "x", apiKey: "test-key", signal: AbortSignal.timeout(1000), fetchImpl: incomplete }),
    (error: unknown) => error instanceof ModelCallError && error.code === "MODEL_INCOMPLETE",
  );
});

test("a model call is skipped when the same scan already has a valid analysis", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-reuse-"));
  const siteone = crawlJson();
  const text = JSON.stringify(siteone);
  let calls = 0;
  const analyze = async () => {
    calls += 1;
    return { analysis: sample("factory.example"), receipt: { model: "qwen4-max" } };
  };
  try {
    const first = await produceCommercial({
      dir,
      siteone,
      siteoneText: text,
      html: null,
      host: "factory.example",
      generatedAt: "2026-11-26T00:00:00.000Z",
      signal: AbortSignal.timeout(1000),
      analyze,
    });
    const second = await produceCommercial({
      dir,
      siteone,
      siteoneText: text,
      html: null,
      host: "factory.example",
      generatedAt: "2026-11-26T00:00:00.000Z",
      signal: AbortSignal.timeout(1000),
      analyze,
    });
    assert.equal(first.available, true);
    assert.equal(second.available, true);
    assert.equal(calls, 1);
    const receipt = JSON.parse(await readFile(path.join(dir, "commercial-receipt.json"), "utf8")) as { reused: boolean };
    assert.equal(receipt.reused, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the scan report still publishes when the model returns counts that do not match", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-commercial-"));
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async () => ["93.184.216.34"],
    run: writeCrawl,
    analyze: async () => ({ analysis: sample("factory.example", 9, 9, 0), receipt: {} }),
  });
  await jobs.recover();
  try {
    const created = await jobs.create(body("commercial-mismatch"));
    const jobRef = (created.body as { job_ref: string }).job_ref;
    const final = await waitState(jobs, jobRef, ["complete", "partial", "failed"]);
    assert.equal(final.report_available, true);
    assert.equal((await jobs.report(jobRef)).status, 200);
    const commercial = await jobs.commercialReport(jobRef);
    assert.equal(commercial.status, 409);
    assert.equal((commercial.body as { error: { code: string } }).error.code, "SOURCE_MISMATCH");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a restart resumes report composition without another model call", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-resume-"));
  const siteone = crawlJson();
  const text = JSON.stringify(siteone);
  const jobRef = "resumeJob01";
  const jobDir = path.join(dir, "jobs", jobRef);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify({
    job_ref: jobRef,
    contract_version: "vfdiag.website-diagnosis.v1",
    state: "summarizing",
    created_at: "2026-11-26T00:00:00.000Z",
    updated_at: "2026-11-26T00:00:00.000Z",
    expires_at: "2026-12-03T00:00:00.000Z",
    target_url: "https://factory.example/products",
    target_host: "factory.example",
    language: "zh",
    report_language: "zh",
    synthetic: false,
    idempotency_key: "resume-key-0001",
    body_hash: "resume",
    scope: { max_urls: 50, max_depth: 3, max_reqs_per_sec: 1, wall_clock_seconds: 180, browser: false },
    checked_pages: null,
    remaining_unknown: true,
    reason_code: null,
    reason: null,
    report_available: false,
    engine_version: "2.5.1",
  }));
  await writeFile(path.join(jobDir, "siteone.json"), text);
  await writeFile(path.join(jobDir, "report.json"), JSON.stringify({ report_language: "zh" }));
  await writeFile(path.join(jobDir, "scan-meta.json"), JSON.stringify({ exitCode: 0, checked_pages: 2 }));
  await writeFile(path.join(jobDir, "analysis.json"), JSON.stringify(sample("factory.example")));
  await writeFile(path.join(jobDir, "commercial-receipt.json"), JSON.stringify({
    siteone_sha256: createHash("sha256").update(text).digest("hex"),
    request_sent: true,
    valid: true,
    code: null,
    reused: false,
    dropped: [],
    model_receipt: null,
  }));
  let calls = 0;
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async () => ["93.184.216.34"],
    run: writeCrawl,
    analyze: async () => {
      calls += 1;
      return { analysis: sample("factory.example"), receipt: {} };
    },
  });
  try {
    await jobs.recover();
    const final = await waitState(jobs, jobRef, ["complete"]);
    assert.equal(final.report_available, true);
    assert.equal((await jobs.commercialReport(jobRef)).status, 200);
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a configured analysis is published on the commercial report route", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-commercial-ok-"));
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async () => ["93.184.216.34"],
    run: writeCrawl,
    analyze: async () => ({ analysis: sample("factory.example"), receipt: { model: "stub" } }),
  });
  await jobs.recover();
  try {
    const created = await jobs.create(body("commercial-ok"));
    const jobRef = (created.body as { job_ref: string }).job_ref;
    const final = await waitState(jobs, jobRef, ["complete"]);
    assert.equal(final.state, "complete");
    const commercial = await jobs.commercialReport(jobRef);
    assert.equal(commercial.status, 200);
    const report = commercial.body as { subject: { domain: string }; delivery: { pdf: { status: string } } };
    assert.equal(report.subject.domain, "factory.example");
    assert.equal(report.delivery.pdf.status, "PENDING_VEYFRONT_PRINT");
    assert.equal(final.customer_report_available, true);
    assert.equal(final.pdf_reason, "PDF_NOT_CONFIGURED");
    assert.equal(final.commercial_contract_version, "vfdiag.commercial-report.v1");
    assert.equal(createHash("sha256").update(JSON.stringify(report)).digest("hex").length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scan-only authorization and synthetic jobs do not call the model", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-commercial-auth-"));
  let calls = 0;
  const analyze = async () => {
    calls += 1;
    return { analysis: sample("factory.example"), receipt: {} };
  };
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(["fixture-site"]),
    lookup: async (host) => host === "fixture-site" ? ["172.16.50.20"] : ["93.184.216.34"],
    run: writeCrawl,
    analyze,
  });
  await jobs.recover();
  try {
    const scan = await jobs.create(body("scan-only", "scan"));
    const scanRef = (scan.body as { job_ref: string }).job_ref;
    const scanFinal = await waitState(jobs, scanRef, ["complete"]);
    assert.equal(scanFinal.report_available, true);
    assert.equal(scanFinal.customer_report_available, false);
    assert.equal(scanFinal.customer_report_reason, "MODEL_NOT_AUTHORIZED");
    const scanReport = await jobs.report(scanRef);
    assert.equal(scanReport.status, 200);
    const scanCommercial = await jobs.commercialReport(scanRef);
    assert.equal(scanCommercial.status, 409);
    assert.equal((scanCommercial.body as { error: { code: string } }).error.code, "MODEL_NOT_AUTHORIZED");

    const synthetic = await jobs.create({ ...body("synthetic-ai"), url: "http://fixture-site:8080/" });
    const syntheticRef = (synthetic.body as { job_ref: string }).job_ref;
    const syntheticFinal = await waitState(jobs, syntheticRef, ["complete"]);
    assert.equal(syntheticFinal.synthetic, true);
    assert.equal(syntheticFinal.customer_report_reason, "COMMERCIAL_SYNTHETIC");
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cancelled job cannot be read and PDF retries do not scan or call the model again", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-commercial-pdf-"));
  const cancelledRef = "cancelled01";
  const cancelledDir = path.join(dir, "jobs", cancelledRef);
  await mkdir(cancelledDir, { recursive: true });
  await writeFile(path.join(cancelledDir, "job.json"), JSON.stringify({
    job_ref: cancelledRef,
    contract_version: "vfdiag.website-diagnosis.v1",
    state: "cancelled",
    created_at: "2026-11-26T00:00:00.000Z",
    updated_at: "2026-11-26T00:00:00.000Z",
    expires_at: "2026-12-03T00:00:00.000Z",
    target_url: "https://factory.example/products",
    target_host: "factory.example",
    language: "zh",
    report_language: "zh",
    synthetic: false,
    idempotency_key: "cancelled-key-01",
    body_hash: "cancelled",
    scope: { max_urls: 50, max_depth: 3, max_reqs_per_sec: 1, wall_clock_seconds: 180, browser: false },
    checked_pages: 2,
    remaining_unknown: true,
    reason_code: "CANCELLED",
    reason: "扫描已取消。",
    report_available: true,
    model_authorized: true,
    customer_report_available: true,
    customer_report_reason: null,
    customer_report_revision: "old",
    pdf_available: true,
    pdf_reason: null,
    engine_version: "2.5.1",
  }));
  await writeFile(path.join(cancelledDir, "commercial-report.json"), JSON.stringify({ revision: "old", overview: { headline: "不应交付" } }));
  let renders = 0;
  let analyzes = 0;
  let scans = 0;
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async () => ["93.184.216.34"],
    run: async (options) => {
      scans += 1;
      if (scans > 1) throw new Error("PDF 重试不应重新扫描。");
      return writeCrawl(options);
    },
    analyze: async () => {
      analyzes += 1;
      return { analysis: sample("factory.example"), receipt: {} };
    },
    renderPdf: async () => {
      renders += 1;
      if (renders === 1) throw new PdfRenderError("PDF_RENDER_FAILED", "打印失败。");
      return Buffer.from("%PDF-1.4\n");
    },
  });
  await jobs.recover();
  try {
    const hidden = await jobs.commercialReport(cancelledRef);
    assert.equal(hidden.status, 409);
    assert.equal((hidden.body as { error: { code: string } }).error.code, "CANCELLED");
    const hiddenPdf = await jobs.artifact(cancelledRef, "pdf");
    assert.equal(hiddenPdf.status, 409);

    const created = await jobs.create(body("pdf-retry"));
    const jobRef = (created.body as { job_ref: string }).job_ref;
    const failed = await waitState(jobs, jobRef, ["complete"]);
    assert.equal(failed.customer_report_available, true);
    const pdfReason = await waitValue(jobs, jobRef, (status) => status.pdf_reason !== "PDF_PENDING");
    assert.equal(pdfReason.pdf_available, false);
    assert.equal(pdfReason.pdf_reason, "PDF_RENDER_FAILED");
    const online = await jobs.commercialReport(jobRef);
    assert.equal(online.status, 200);
    const revision = (online.body as { revision: string }).revision;
    const mismatch = await jobs.commercialReport(jobRef, "not-the-revision");
    assert.equal(mismatch.status, 409);
    assert.equal((mismatch.body as { error: { code: string } }).error.code, "REVISION_MISMATCH");
    const retried = await jobs.retryPdf(jobRef);
    assert.equal(retried.status, 200);
    assert.equal((retried.body as { pdf_available: boolean }).pdf_available, true);
    const downloaded = await jobs.artifact(jobRef, "pdf", revision);
    assert.equal(downloaded.status, 200);
    if ("contentType" in downloaded) assert.equal(downloaded.body.subarray(0, 5).toString("utf8"), "%PDF-");
    assert.equal(analyzes, 1);
    assert.equal(renders, 2);
    assert.equal(scans, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function sample(domain: string, checked = 2, http200 = 2, http301 = 0) {
  return {
    schema_version: "veyfront.report-analysis.v0.1",
    mode: "validation",
    source_profile: {
      target_domain: domain,
      observed_at: "2026-11-26 10:00:00",
      checked_urls: checked,
      http_200: http200,
      http_301: http301,
      scope_summary: "本次只看了公开页面。",
      data_sufficiency: "adequate_for_limited_report" as const,
      limitations: ["未读取正文。"],
    },
    technical_scorecard: {
      is_business_score: false as const,
      overall: { label: "技术评分", score: 5, max_score: 10, caveat: "不是获客评分。" },
      dimensions: [],
    },
    evidence_index: [
      { id: "E01", observed_fact: "首页返回 200。", source_url: `https://${domain}/`, raw_value: 200, denominator: null },
    ],
    diagnosis: {
      headline: `${domain} 已有产品页和联系页。`,
      verdict: "targeted_optimization" as const,
      verdict_reason: "两类页面都能打开。",
      strengths: [{ text: "联系页可以打开。", evidence_ids: ["E01"] }],
      priority_findings: [
        {
          id: "F01",
          priority: "P1",
          business_area: "product_discoverability",
          title: "产品页可以打开",
          observed_fact: "产品页返回 200。",
          possible_business_effect: "买家有机会看到产品。",
          recommended_action: "核对这些页面的标题是否各自不同。",
          acceptance_checks: ["标题不同"],
          needs_confirmation: [],
          evidence_ids: ["E01"],
          effect_level: "INFERRED",
        },
      ],
      buyer_tasks: [
        { task: "find_products", status: "OBSERVED", fact: "有产品页。", what_is_not_known: "", evidence_ids: ["E01"] },
      ],
      technical_notes: [],
      not_checked: ["未提交表单"],
    },
    visual_plan: [],
    conversion: {
      offer_name: "升级方向沟通",
      offer_scope: "基于本次已打开的页面。",
      cta_label: "选择先看哪一类页面",
      cta_request: "先确认产品页或联系页。",
      unpromised_fields: ["不承诺搜索排名"],
    },
    risk_review: { manual_review_needed: true, manual_review_reasons: ["研究字段"] },
  };
}

function crawlJson(host = "factory.example") {
  return {
    crawler: { version: "2.5.1", executedAt: "2026-11-26 10:00:00" },
    stats: { totalUrls: 2 },
    results: [
      { url: `https://${host}/products/valve`, status: "200", type: 1 },
      { url: `https://${host}/contact`, status: "200", type: 1 },
    ],
  };
}

function body(key: string, mode: "growth" | "scan" = "growth") {
  const growth = mode === "growth";
  return {
    contract_version: "vfdiag.website-diagnosis.v1" as const,
    url: "https://factory.example/products",
    language: "zh" as const,
    idempotency_key: key,
    model_authorized: growth,
    authorization: {
      version: growth ? MODEL_AUTHORIZATION_VERSION : "2026-11-22",
      accepted: true,
      accepted_at: "2026-11-26T00:00:00.000Z",
      text_hash: growth ? modelAuthorizationTextHash() : authorizationTextHash(),
    },
  };
}

async function writeCrawl(options: { htmlFile: string; jsonFile: string; target?: { host: string } }): Promise<CrawlResult> {
  const jsonText = JSON.stringify(crawlJson(options.target?.host));
  await writeFile(options.htmlFile, "<html>synthetic</html>");
  await writeFile(options.jsonFile, jsonText);
  return { exitCode: 0, timedOut: false, cancelled: false, jsonText, html: Buffer.from("<html>synthetic</html>"), errorCode: null, errorMessage: null };
}

async function waitValue(jobs: ReturnType<typeof createJobService>, jobRef: string, ready: (status: { pdf_available?: boolean; pdf_reason?: string | null }) => boolean) {
  const deadline = Date.now() + 3000;
  let body: { pdf_available?: boolean; pdf_reason?: string | null } = {};
  while (Date.now() < deadline) {
    const got = await jobs.get(jobRef);
    body = got.body as typeof body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${JSON.stringify(body)}`);
}

async function waitState(jobs: ReturnType<typeof createJobService>, jobRef: string, states: string[]) {
  const deadline = Date.now() + 3000;
  let body: {
    state?: string;
    report_available?: boolean;
    customer_report_available?: boolean;
    customer_report_reason?: string | null;
    commercial_contract_version?: string | null;
    pdf_available?: boolean;
    pdf_reason?: string | null;
    synthetic?: boolean;
  } = {};
  while (Date.now() < deadline) {
    const got = await jobs.get(jobRef);
    body = got.body as typeof body;
    if (body.state && states.includes(body.state)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${JSON.stringify(body)}`);
}
