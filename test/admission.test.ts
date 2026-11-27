import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MODEL_AUTHORIZATION_VERSION } from "../src/constants.ts";
import { authorizationTextHash, modelAuthorizationTextHash } from "../src/http/request.ts";
import { createHttpServer } from "../src/http/server.ts";
import { callCeilingFen, minimumCallCeilingFen } from "../src/commercial/qwen.ts";
import { canonicalHost, decideAdmission, emptyLedger, readAdmissionHeaders, readBudgetCaps, reserveAdmission, shanghaiDay, syncAdmission } from "../src/jobs/admission.ts";
import { createJobService } from "../src/jobs/service.ts";
import type { CrawlResult } from "../src/siteone/run.ts";

const browserA = "a".repeat(64);
const browserB = "b".repeat(64);
const network = "c".repeat(64);
const clock = new Date("2026-11-26T02:00:00.000Z");

test("canonical host ignores www and paths but keeps other subdomains", () => {
  assert.equal(canonicalHost("https://www.factory.example/products?x=1"), "factory.example");
  assert.equal(canonicalHost("http://www.factory.example/"), "factory.example");
  assert.equal(canonicalHost("https://factory.example/contact"), "factory.example");
  assert.equal(canonicalHost("https://en.factory.example/"), "en.factory.example");
  assert.equal(canonicalHost("https://www.en.factory.example/about"), "en.factory.example");
  assert.equal(shanghaiDay(new Date("2026-11-26T15:59:59.000Z")), "2026-11-26");
  assert.equal(shanghaiDay(new Date("2026-11-26T16:00:00.000Z")), "2026-11-27");
});

test("admission decisions refuse without revealing a job", () => {
  const now = clock;
  let ledger = emptyLedger();
  ledger = reserveAdmission(ledger, { now, host: "factory.example", browser: browserA, ip: network, jobRef: "job-secret-1" });
  const inProgress = decideAdmission(ledger, { now, host: "www.factory.example".replace(/^www\./, ""), browser: browserB, ip: network });
  assert.equal(inProgress.ok, false);
  if (!inProgress.ok) {
    assert.equal(inProgress.code, "SITE_DIAGNOSIS_IN_PROGRESS");
    assert.equal(JSON.stringify(inProgress).includes("job-secret-1"), false);
  }
  ledger.sites["factory.example"].active_job = null;
  ledger.sites["factory.example"].success_at = now.toISOString();
  const recent = decideAdmission(ledger, { now, host: "factory.example", browser: browserB, ip: network });
  assert.equal(recent.ok, false);
  if (!recent.ok) assert.equal(recent.code, "SITE_RECENTLY_DIAGNOSED");
  const subdomain = decideAdmission(ledger, { now, host: "en.factory.example", browser: browserB, ip: network });
  assert.equal(subdomain.ok, true);
  const otherSite = decideAdmission(ledger, { now, host: "other.example", browser: browserA, ip: network });
  assert.equal(otherSite.ok, false);
  if (!otherSite.ok) assert.equal(otherSite.code, "BROWSER_DAILY_LIMIT");
  ledger.days[shanghaiDay(now)].ips[network] = 5;
  const ip = decideAdmission(ledger, { now, host: "other.example", browser: browserB, ip: network });
  assert.equal(ip.ok, false);
  if (!ip.ok) assert.equal(ip.code, "IP_DAILY_LIMIT");
  ledger.days[shanghaiDay(now)].ips[network] = 1;
  ledger.charges.spent = { host: "factory.example", at: now.toISOString(), fen: 100, priced: true, unresolved: false, blocks_model: true };
  const underCap = decideAdmission(ledger, { now, host: "other.example", browser: browserB, ip: "d".repeat(64) });
  assert.equal(underCap.ok, true);
  ledger.charges.spent.fen = 3_000;
  const budget = decideAdmission(ledger, { now, host: "other.example", browser: browserB, ip: "d".repeat(64) });
  assert.equal(budget.ok, false);
  if (!budget.ok) {
    assert.equal(budget.code, "DAILY_BUDGET_LIMIT");
    assert.equal(budget.message.includes("今日"), true);
  }
});

test("paid creates enforce admission and keep existing reports readable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-"));
  let calls = 0;
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => clock,
    budgets: { siteFen: 600, dailyFen: 600, monthlyFen: 50_000 },
    lookup: async () => ["93.184.216.34"],
    run: writeCrawl,
    analyze: async () => {
      calls += 1;
      return { analysis: sample("factory.example"), receipt: { estimated_cost_cny: 6 } };
    },
    renderPdf: async () => Buffer.from("%PDF-1.4\n"),
  });
  await jobs.recover();
  try {
    const missing = await jobs.create(paid("https://factory.example/products", "admit-missing"), null);
    assert.equal(missing.status, 400);
    assert.equal(code(missing.body), "ADMISSION_REQUIRED");

    const created = await jobs.create(paid("https://factory.example/products", "admit-ok"), { browser: browserA, ip: network });
    assert.equal(created.status, 202);
    const jobRef = (created.body as { job_ref: string }).job_ref;
    const replay = await jobs.create(paid("https://factory.example/products", "admit-ok"), { browser: browserA, ip: network });
    assert.equal(replay.status, 200);
    assert.equal((replay.body as { job_ref: string }).job_ref, jobRef);
    const copied = await jobs.create(paid("https://factory.example/products", "admit-ok"), { browser: browserB, ip: network });
    assert.equal(copied.status, 409);
    assert.equal(code(copied.body), "IDEMPOTENCY_CONFLICT");
    assert.equal(JSON.stringify(copied.body).includes(jobRef), false);

    const done = await waitState(jobs, jobRef, ["complete"]);
    assert.equal(done.customer_report_available, true);
    assert.equal(calls, 1);
    const pdf = await waitPdf(jobs, jobRef);
    assert.equal(pdf.pdf_available, true);
    const file = await jobs.artifact(jobRef, "pdf", done.customer_report_revision);
    assert.equal(file.status, 200);

    const ledger = JSON.parse(await readFile(path.join(dir, "admission.json"), "utf8")) as { days: Record<string, { ips: Record<string, number> }> };
    assert.equal(ledger.days["2026-11-26"].ips[network], 1);
    const secondSite = await jobs.create(paid("https://other.example/", "admit-browser"), { browser: browserA, ip: "e".repeat(64) });
    assert.equal(secondSite.status, 429);
    assert.equal(code(secondSite.body), "BROWSER_DAILY_LIMIT");
    assert.equal("job_ref" in (secondSite.body as object), false);

    const alias = await jobs.create(paid("https://www.factory.example/about", "admit-alias"), { browser: browserB, ip: network });
    assert.equal(alias.status, 409);
    assert.equal(code(alias.body), "SITE_RECENTLY_DIAGNOSED");
    assert.equal(JSON.stringify(alias.body).includes(jobRef), false);
    assert.equal((await jobs.commercialReport(jobRef)).status, 200);
    assert.equal((await jobs.artifact(jobRef, "pdf", done.customer_report_revision)).status, 200);

    const budget = await jobs.create(paid("https://other.example/", "admit-budget"), { browser: browserB, ip: "d".repeat(64) });
    assert.equal(budget.status, 429);
    assert.equal(code(budget.body), "DAILY_BUDGET_LIMIT");
    assert.equal("job_ref" in (budget.body as object), false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

test("a failed paid diagnosis can be retried without a second model call", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-retry-"));
  let calls = 0;
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => clock,
    lookup: async () => ["93.184.216.34"],
    run: writeCrawl,
    analyze: async () => {
      calls += 1;
      throw new Error("模型调用失败。");
    },
  });
  await jobs.recover();
  try {
    const first = await jobs.create(paid("https://factory.example/", "admit-fail-1"), { browser: browserA, ip: network });
    const jobRef = (first.body as { job_ref: string }).job_ref;
    await waitState(jobs, jobRef, ["complete", "partial", "failed"]);
    assert.equal(calls, 1);
    const second = await jobs.create(paid("https://factory.example/retry", "admit-fail-2"), { browser: browserA, ip: network });
    assert.equal(second.status, 202);
    await waitState(jobs, (second.body as { job_ref: string }).job_ref, ["complete", "partial", "failed"]);
    assert.equal(calls, 1);
    const commercial = await jobs.commercialReport((second.body as { job_ref: string }).job_ref);
    assert.equal(code(commercial.body), "MODEL_INTERRUPTED");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

test("budget caps bill the actual charge once and stay inside their own period", () => {
  const caps = { siteFen: 600, dailyFen: 3_000, monthlyFen: 50_000 };
  const nov26 = new Date("2026-11-26T02:00:00.000Z");
  const nov27 = new Date("2026-11-27T02:00:00.000Z");
  const dec1 = new Date("2026-12-01T02:00:00.000Z");
  let ledger = emptyLedger();
  ledger = syncAdmission(ledger, { now: nov26, host: "factory.example", jobRef: "priced", at: nov26.toISOString(), active: false, success: false, settled: true, requestSent: true, connectionFailure: false, costCny: 1 }).ledger;
  ledger = syncAdmission(ledger, { now: nov26, host: "factory.example", jobRef: "priced", at: "2026-12-01T00:00:00.000Z", active: false, success: false, settled: true, requestSent: true, connectionFailure: false, costCny: 1 }).ledger;
  assert.equal(ledger.charges.priced.fen, 100);
  assert.equal(ledger.charges.priced.at, nov26.toISOString());
  assert.equal(decideAdmission(ledger, { now: nov26, host: "other.example", browser: browserB, ip: network }, caps).ok, true);
  const daily = decideAdmission(ledger, { now: nov26, host: "other.example", browser: browserB, ip: network }, { ...caps, dailyFen: 100 });
  assert.equal(daily.ok, false);
  if (!daily.ok) assert.equal(daily.message.includes("今日"), true);
  const month = decideAdmission(ledger, { now: nov27, host: "other.example", browser: browserB, ip: network }, { ...caps, monthlyFen: 100 });
  assert.equal(month.ok, false);
  if (!month.ok) assert.equal(month.message.includes("本月"), true);
  assert.equal(decideAdmission(ledger, { now: dec1, host: "other.example", browser: browserB, ip: network }, { ...caps, monthlyFen: 100 }).ok, true);
  const site = decideAdmission(ledger, { now: nov26, host: "factory.example", browser: browserB, ip: "d".repeat(64) }, { ...caps, siteFen: 100 });
  assert.equal(site.ok, false);
  if (!site.ok) assert.equal(site.message.includes("单站"), true);

  ledger = syncAdmission(ledger, { now: nov26, host: "open.example", jobRef: "unknown", at: nov26.toISOString(), active: true, success: false, settled: false, requestSent: true, connectionFailure: false, costCny: null, ceilingFen: 80 }).ledger;
  assert.equal(ledger.charges.unknown.ceiling_fen, 80);
  assert.equal(decideAdmission(ledger, { now: nov26, host: "third.example", browser: browserB, ip: "e".repeat(64) }, { ...caps, dailyFen: 200 }).ok, true);
  const tight = decideAdmission(ledger, { now: nov26, host: "third.example", browser: browserB, ip: "e".repeat(64) }, { ...caps, dailyFen: 190 }, 20);
  assert.equal(tight.ok, false);
  if (!tight.ok) assert.equal(tight.message.includes("下一次"), true);
  ledger = syncAdmission(ledger, { now: nov27, host: "open.example", jobRef: "unknown", at: "2026-12-02T00:00:00.000Z", active: false, success: false, settled: true, requestSent: true, connectionFailure: false, costCny: null, ceilingFen: 500 }).ledger;
  assert.equal(ledger.charges.unknown.unresolved, true);
  assert.equal(ledger.charges.unknown.fen, 0);
  assert.equal(ledger.charges.unknown.ceiling_fen, 500);
  assert.equal(ledger.charges.unknown.at, nov26.toISOString());
  const held = decideAdmission(ledger, { now: nov26, host: "third.example", browser: browserB, ip: "e".repeat(64) }, { ...caps, dailyFen: 600 });
  assert.equal(held.ok, false);
  ledger = syncAdmission(ledger, { now: dec1, host: "open.example", jobRef: "unknown", at: dec1.toISOString(), active: false, success: false, settled: true, requestSent: true, connectionFailure: false, costCny: 1.5 }).ledger;
  assert.equal(ledger.charges.unknown.fen, 150);
  assert.equal(ledger.charges.unknown.unresolved, false);
  assert.equal(ledger.charges.unknown.at, nov26.toISOString());
  assert.equal(decideAdmission(ledger, { now: nov26, host: "third.example", browser: browserB, ip: "e".repeat(64) }, { ...caps, dailyFen: 600 }).ok, true);

  ledger = syncAdmission(ledger, { now: nov26, host: "down.example", jobRef: "offline", at: nov26.toISOString(), active: false, success: false, settled: true, requestSent: true, connectionFailure: true, costCny: null }).ledger;
  assert.equal(ledger.charges.offline.fen, 0);
  assert.equal(ledger.charges.offline.blocks_model, false);
  assert.equal(readBudgetCaps({ VFDIAG_SITE_MODEL_BUDGET_CNY: "6.5", VFDIAG_DAILY_MODEL_BUDGET_CNY: "bad", VFDIAG_MONTHLY_MODEL_BUDGET_CNY: "" }).dailyFen, 3_000);
  assert.equal(readBudgetCaps({ VFDIAG_SITE_MODEL_BUDGET_CNY: "6.5" }).siteFen, 650);
  const floor = minimumCallCeilingFen();
  assert.ok(floor > 0);
  assert.ok(floor < 600);
  assert.ok(callCeilingFen("甲".repeat(8000)) > floor);
  const clear = emptyLedger();
  const ahead = decideAdmission(clear, { now: nov26, host: "clear.example", browser: browserB, ip: "f".repeat(64) }, { ...caps, dailyFen: floor }, floor);
  assert.equal(ahead.ok, true);
  const overrun = decideAdmission(clear, { now: nov26, host: "clear.example", browser: browserB, ip: "f".repeat(64) }, { ...caps, dailyFen: floor - 1 }, floor);
  assert.equal(overrun.ok, false);
  if (!overrun.ok) assert.equal(overrun.message.includes("下一次"), true);
});

test("a paid create stops before the model when the next call cannot fit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-ceiling-"));
  const floor = minimumCallCeilingFen();
  let calls = 0;
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => clock,
    budgets: { siteFen: 100_000, dailyFen: floor - 1, monthlyFen: 100_000 },
    lookup: async () => ["93.184.216.34"],
    run: writeCrawl,
    analyze: async () => {
      calls += 1;
      return { analysis: sample("factory.example"), receipt: { estimated_cost_cny: 0.2 } };
    },
  });
  await jobs.recover();
  try {
    const created = await jobs.create(paid("https://factory.example/", "admit-ceiling"), { browser: browserA, ip: network });
    assert.equal(created.status, 429);
    assert.equal(code(created.body), "DAILY_BUDGET_LIMIT");
    assert.equal((created.body as { error: { message: string } }).error.message.includes("下一次"), true);
    assert.equal("job_ref" in (created.body as object), false);
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

test("a larger scan is refused at the model call even when the minimum ceiling still fits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-headroom-"));
  const floor = minimumCallCeilingFen();
  let calls = 0;
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => clock,
    budgets: { siteFen: 100_000, dailyFen: floor, monthlyFen: 100_000 },
    lookup: async () => ["93.184.216.34"],
    run: async (options) => {
      const body = crawlJson();
      body.results.push({ url: `https://factory.example/${"甲".repeat(20_000)}`, status: "200", type: 1 });
      const jsonText = JSON.stringify(body);
      await writeFile(options.htmlFile, "<html>synthetic</html>");
      await writeFile(options.jsonFile, jsonText);
      return { exitCode: 0, timedOut: false, cancelled: false, jsonText, html: Buffer.from("<html>synthetic</html>"), errorCode: null, errorMessage: null };
    },
    analyze: async () => {
      calls += 1;
      return { analysis: sample("factory.example"), receipt: { estimated_cost_cny: 0.2 } };
    },
  });
  await jobs.recover();
  try {
    const created = await jobs.create(paid("https://factory.example/", "admit-headroom"), { browser: browserA, ip: network });
    assert.equal(created.status, 202);
    const jobRef = (created.body as { job_ref: string }).job_ref;
    const done = await waitState(jobs, jobRef, ["complete", "failed", "partial"]);
    assert.equal(done.customer_report_available, false);
    assert.equal(done.customer_report_reason, "DAILY_BUDGET_LIMIT");
    assert.equal(calls, 0);
    const error = JSON.parse(await readFile(path.join(dir, "jobs", jobRef, "commercial-error.json"), "utf8")) as { message?: string };
    assert.equal(error.message?.includes("下一次"), true);
    const receipt = await readFile(path.join(dir, "jobs", jobRef, "commercial-receipt.json"), "utf8").catch(() => "");
    assert.equal(receipt.includes("request_sent"), false);
    const ledger = JSON.parse(await readFile(path.join(dir, "admission.json"), "utf8")) as { charges?: Record<string, unknown> };
    assert.equal(ledger.charges?.[jobRef], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

test("historical reports stay deduplicated without booking the per-site cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-history-"));
  const jobRef = "historyjob01";
  const jobDir = path.join(dir, "jobs", jobRef);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify({
    job_ref: jobRef,
    contract_version: "vfdiag.website-diagnosis.v1",
    state: "complete",
    created_at: "2026-11-26T14:12:16.548Z",
    updated_at: "2026-11-27T02:33:59.459Z",
    expires_at: "2026-12-03T14:12:16.548Z",
    target_url: "https://www.factory.example/products",
    target_host: "www.factory.example",
    language: "zh",
    report_language: "zh",
    synthetic: false,
    idempotency_key: "history-old",
    body_hash: "history",
    scope: { max_urls: 50, max_depth: 3, max_reqs_per_sec: 1, wall_clock_seconds: 180, browser: false },
    checked_pages: 2,
    remaining_unknown: true,
    reason_code: null,
    reason: null,
    report_available: true,
    model_authorized: true,
    customer_report_available: true,
    customer_report_reason: null,
    customer_report_revision: "rev",
    pdf_available: true,
    pdf_reason: null,
    engine_version: "2.5.1",
  }));
  await writeFile(path.join(jobDir, "commercial-report.json"), JSON.stringify({ revision: "rev", generated_at: "2026-11-26T14:13:17.515Z" }));
  await writeFile(path.join(jobDir, "commercial-receipt.json"), JSON.stringify({ request_sent: true, valid: true, model_receipt: { estimated_cost_cny: 1.05269 } }));
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => clock,
    lookup: async () => ["93.184.216.34"],
    run: writeCrawl,
  });
  try {
    await jobs.recover();
    await jobs.recover();
    const ledger = JSON.parse(await readFile(path.join(dir, "admission.json"), "utf8")) as { charges: Record<string, { fen: number; at: string }>; sites: Record<string, { success_at: string | null }> };
    assert.equal(ledger.charges[jobRef].fen, 105);
    assert.equal(ledger.charges[jobRef].at, "2026-11-26T14:13:17.515Z");
    assert.equal(ledger.sites["factory.example"].success_at, "2026-11-26T14:13:17.515Z");
    const again = await jobs.create(paid("https://factory.example/new", "history-new"), { browser: browserB, ip: network });
    assert.equal(again.status, 409);
    assert.equal(code(again.body), "SITE_RECENTLY_DIAGNOSED");
    assert.equal("job_ref" in (again.body as object), false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

test("one network can open at most five new tasks in a Shanghai day", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-ip-"));
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => clock,
    lookup: async () => ["93.184.216.34"],
    run: async () => ({ exitCode: 1, timedOut: false, cancelled: false, jsonText: null, html: null, errorCode: "ENGINE_FAILED", errorMessage: "测试失败。" }),
  });
  await jobs.recover();
  try {
    for (let index = 0; index < 5; index += 1) {
      const created = await jobs.create(paid(`https://site${index}.example/`, `admit-ip-${index}`), { browser: String(index + 1).repeat(64), ip: network });
      assert.equal(created.status, 202);
      await waitState(jobs, (created.body as { job_ref: string }).job_ref, ["failed"]);
    }
    const blocked = await jobs.create(paid("https://site5.example/", "admit-ip-5"), { browser: "f".repeat(64), ip: network });
    assert.equal(blocked.status, 429);
    assert.equal(code(blocked.body), "IP_DAILY_LIMIT");
    assert.equal("job_ref" in (blocked.body as object), false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

test("cancelling a diagnosis releases the site and does not call the model", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-cancel-"));
  let calls = 0;
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => clock,
    lookup: async () => ["93.184.216.34"],
    run: (options) => new Promise((resolve) => {
      const finish = () => resolve({ exitCode: null, timedOut: false, cancelled: true, jsonText: null, html: null, errorCode: null, errorMessage: null });
      if (options.signal.aborted) finish();
      else options.signal.addEventListener("abort", finish, { once: true });
    }),
    analyze: async () => {
      calls += 1;
      return { analysis: sample("factory.example"), receipt: { estimated_cost_cny: 1 } };
    },
  });
  await jobs.recover();
  try {
    const first = await jobs.create(paid("https://factory.example/", "admit-cancel-1"), { browser: browserA, ip: network });
    const jobRef = (first.body as { job_ref: string }).job_ref;
    const cancelled = await jobs.cancel(jobRef);
    assert.equal(cancelled.status, 202);
    assert.equal(calls, 0);
    const second = await jobs.create(paid("https://www.factory.example/again", "admit-cancel-2"), { browser: browserA, ip: network });
    assert.equal(second.status, 202);
    const secondRef = (second.body as { job_ref: string }).job_ref;
    await jobs.cancel(secondRef);
    await waitState(jobs, jobRef, ["cancelled"]);
    await waitState(jobs, secondRef, ["cancelled"]);
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

test("a restart after a sent model request does not call the model again", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-restart-"));
  const jobRef = "restartjob01";
  const jobDir = path.join(dir, "jobs", jobRef);
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(jobDir, "job.json"), JSON.stringify({
    job_ref: jobRef,
    contract_version: "vfdiag.website-diagnosis.v1",
    state: "running",
    created_at: "2026-11-26T02:00:00.000Z",
    updated_at: "2026-11-26T02:00:00.000Z",
    expires_at: "2026-12-03T02:00:00.000Z",
    target_url: "https://factory.example/",
    target_host: "factory.example",
    language: "zh",
    report_language: "zh",
    synthetic: false,
    idempotency_key: "admit-restart-old",
    body_hash: "restart",
    scope: { max_urls: 50, max_depth: 3, max_reqs_per_sec: 1, wall_clock_seconds: 180, browser: false },
    checked_pages: null,
    remaining_unknown: true,
    reason_code: null,
    reason: null,
    report_available: false,
    model_authorized: true,
    customer_report_available: false,
    customer_report_reason: null,
    customer_report_revision: null,
    pdf_available: false,
    pdf_reason: null,
    engine_version: null,
    canonical_host: "factory.example",
    admission_browser: browserA,
  }));
  await writeFile(path.join(jobDir, "commercial-receipt.json"), JSON.stringify({ request_sent: true, model_receipt: { estimated_cost_cny: 1.25 } }));
  let calls = 0;
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => clock,
    lookup: async () => ["93.184.216.34"],
    run: writeCrawl,
    analyze: async () => {
      calls += 1;
      return { analysis: sample("factory.example"), receipt: { estimated_cost_cny: 6 } };
    },
  });
  try {
    await jobs.recover();
    const recovered = await jobs.get(jobRef);
    assert.equal((recovered.body as { state: string }).state, "failed");
    assert.equal((recovered.body as { reason_code: string }).reason_code, "WORKER_RESTARTED");
    const again = await jobs.create(paid("https://factory.example/retry", "admit-restart-new"), { browser: browserA, ip: network });
    assert.equal(again.status, 202);
    await waitState(jobs, (again.body as { job_ref: string }).job_ref, ["complete", "partial", "failed"]);
    assert.equal(calls, 0);
    const commercial = await jobs.commercialReport((again.body as { job_ref: string }).job_ref);
    assert.equal(code(commercial.body), "MODEL_INTERRUPTED");
    const ledger = JSON.parse(await readFile(path.join(dir, "admission.json"), "utf8")) as { charges: Record<string, { fen: number }> };
    assert.equal(Object.values(ledger.charges).reduce((sum, charge) => sum + charge.fen, 0), 125);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

test("the same site cannot be created twice while a diagnosis is running", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-busy-"));
  let release: () => void = () => {};
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => clock,
    lookup: async () => ["93.184.216.34"],
    run: () => new Promise((resolve) => {
      started();
      release = () => resolve(crawlOk());
    }),
  });
  await jobs.recover();
  try {
    const first = jobs.create(paid("https://factory.example/", "admit-busy-1"), { browser: browserA, ip: network });
    const second = jobs.create(paid("https://www.factory.example/path", "admit-busy-2"), { browser: browserB, ip: network });
    const [created, rejected] = await Promise.all([first, second]);
    const ok = created.status === 202 ? created : rejected;
    const no = created.status === 202 ? rejected : created;
    assert.equal(ok.status, 202);
    assert.equal(no.status, 409);
    assert.equal(code(no.body), "SITE_DIAGNOSIS_IN_PROGRESS");
    assert.equal(JSON.stringify(no.body).includes((ok.body as { job_ref: string }).job_ref), false);
    await running;
    release();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

test("growth HTTP requires the admission headers and scan-only does not", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-admit-http-"));
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async () => ["93.184.216.34"],
    run: async () => crawlOk(),
  });
  const server = createHttpServer({ token: "local-test-token-value", jobs });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const scan = await post(base, {
      contract_version: "vfdiag.website-diagnosis.v1",
      url: "https://factory.example/",
      language: "zh",
      idempotency_key: "http-scan-only",
      model_authorized: false,
      authorization: {
        version: "2026-11-22",
        accepted: true,
        accepted_at: "2026-11-26T00:00:00.000Z",
        text_hash: authorizationTextHash(),
      },
    });
    assert.equal(scan.status, 202);
    const scanRef = ((await scan.json()) as { job_ref: string }).job_ref;
    const scanDeadline = Date.now() + 3000;
    while (Date.now() < scanDeadline) {
      const status = await fetch(`${base}/v1/jobs/${scanRef}`, { headers: { authorization: "Bearer local-test-token-value" } });
      const body = await status.json() as { state?: string };
      if (body.state === "complete" || body.state === "failed" || body.state === "partial") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const absent = await post(base, paid("https://factory.example/", "http-absent"));
    assert.equal(absent.status, 400);
    assert.equal(code(await absent.json()), "ADMISSION_REQUIRED");
    const stale = await post(base, paid("https://factory.example/", "http-stale"), { "x-vf-admission-day": "2000-01-01", "x-vf-admission-browser": browserA, "x-vf-admission-ip": network });
    assert.equal(stale.status, 400);
    const headers = readAdmissionHeaders({ get: () => null }, clock);
    assert.equal(headers.ok, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 40 });
  }
});

function paid(url: string, key: string) {
  return {
    contract_version: "vfdiag.website-diagnosis.v1" as const,
    url,
    language: "zh" as const,
    idempotency_key: key,
    model_authorized: true,
    authorization: {
      version: MODEL_AUTHORIZATION_VERSION,
      accepted: true as const,
      accepted_at: "2026-11-26T00:00:00.000Z",
      text_hash: modelAuthorizationTextHash(),
    },
  };
}

function code(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

function post(base: string, body: ReturnType<typeof paid>, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/jobs`, {
    method: "POST",
    headers: { authorization: "Bearer local-test-token-value", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function waitState(jobs: ReturnType<typeof createJobService>, jobRef: string, states: string[]) {
  const deadline = Date.now() + 3000;
  let body: { state?: string; customer_report_available?: boolean; customer_report_revision?: string | null } = {};
  while (Date.now() < deadline) {
    const got = await jobs.get(jobRef);
    body = got.body as typeof body;
    if (body.state && states.includes(body.state)) return body;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timed out: ${JSON.stringify(body)}`);
}

async function waitPdf(jobs: ReturnType<typeof createJobService>, jobRef: string) {
  const deadline = Date.now() + 3000;
  let body: { pdf_available?: boolean } = {};
  while (Date.now() < deadline) {
    const got = await jobs.get(jobRef);
    body = got.body as typeof body;
    if (body.pdf_available) return body;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`pdf timed out: ${JSON.stringify(body)}`);
}

async function writeCrawl(options: { htmlFile: string; jsonFile: string }): Promise<CrawlResult> {
  const jsonText = JSON.stringify(crawlJson());
  await writeFile(options.htmlFile, "<html>synthetic</html>");
  await writeFile(options.jsonFile, jsonText);
  return { exitCode: 0, timedOut: false, cancelled: false, jsonText, html: Buffer.from("<html>synthetic</html>"), errorCode: null, errorMessage: null };
}

function crawlOk(): CrawlResult {
  return { exitCode: 0, timedOut: false, cancelled: false, jsonText: JSON.stringify(crawlJson()), html: Buffer.from("<html></html>"), errorCode: null, errorMessage: null };
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

function sample(domain: string) {
  return {
    schema_version: "veyfront.report-analysis.v0.1",
    mode: "validation",
    source_profile: {
      target_domain: domain,
      observed_at: "2026-11-26 10:00:00",
      checked_urls: 2,
      http_200: 2,
      http_301: 0,
      scope_summary: "本次只看了公开页面。",
      data_sufficiency: "adequate_for_limited_report",
      limitations: ["未读取正文。"],
    },
    technical_scorecard: {
      is_business_score: false,
      overall: { label: "技术评分", score: 5, max_score: 10, caveat: "不是获客评分。" },
      dimensions: [],
    },
    evidence_index: [
      { id: "E01", observed_fact: "首页返回 200。", source_url: `https://${domain}/`, raw_value: 200, denominator: null },
    ],
    diagnosis: {
      headline: `${domain} 已有产品页和联系页。`,
      verdict: "targeted_optimization",
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
