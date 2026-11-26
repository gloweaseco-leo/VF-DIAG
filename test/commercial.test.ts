import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { composeCommercialReport } from "../src/commercial/compose.ts";
import { callQwen, ModelCallError, qwenEndpoint, buildQwenPayload } from "../src/commercial/qwen.ts";
import { deriveScoreScale } from "../src/commercial/score-scale.ts";
import { produceCommercial } from "../src/commercial/stage.ts";
import { authorizationTextHash } from "../src/http/request.ts";
import { createJobService } from "../src/jobs/service.ts";
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
    assert.equal(createHash("sha256").update(JSON.stringify(report)).digest("hex").length, 64);
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

function crawlJson() {
  return {
    crawler: { version: "2.5.1", executedAt: "2026-11-26 10:00:00" },
    stats: { totalUrls: 2 },
    results: [
      { url: "https://factory.example/products/valve", status: "200", type: 1 },
      { url: "https://factory.example/contact", status: "200", type: 1 },
    ],
  };
}

function body(key: string) {
  return {
    contract_version: "vfdiag.website-diagnosis.v1" as const,
    url: "https://factory.example/products",
    language: "zh" as const,
    idempotency_key: key,
    authorization: {
      version: "2026-11-22",
      accepted: true,
      accepted_at: "2026-11-26T00:00:00.000Z",
      text_hash: authorizationTextHash(),
    },
  };
}

async function writeCrawl(options: { htmlFile: string; jsonFile: string }): Promise<CrawlResult> {
  const jsonText = JSON.stringify(crawlJson());
  await writeFile(options.htmlFile, "<html>synthetic</html>");
  await writeFile(options.jsonFile, jsonText);
  return { exitCode: 0, timedOut: false, cancelled: false, jsonText, html: Buffer.from("<html>synthetic</html>"), errorCode: null, errorMessage: null };
}

async function waitState(jobs: ReturnType<typeof createJobService>, jobRef: string, states: string[]) {
  const deadline = Date.now() + 3000;
  let body: { state?: string; report_available?: boolean } = {};
  while (Date.now() < deadline) {
    const got = await jobs.get(jobRef);
    body = got.body as typeof body;
    if (body.state && states.includes(body.state)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${JSON.stringify(body)}`);
}
