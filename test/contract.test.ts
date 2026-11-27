import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizationTextHash } from "../src/http/request.ts";
import { createHttpServer } from "../src/http/server.ts";
import { createJobService } from "../src/jobs/service.ts";
import type { CrawlResult } from "../src/siteone/run.ts";

const token = "local-test-token-value";

test("cancel stops a running job and does not publish a report", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-cancel-"));
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async () => ["93.184.216.34"],
    run: ({ signal }) =>
      new Promise((resolve) => {
        markReady();
        const finish = () => resolve(cancelledCrawl());
        if (signal.aborted) finish();
        else signal.addEventListener("abort", finish, { once: true });
      }),
  });
  const { base, close } = await listen(jobs);
  try {
    const created = await post(base, "https://factory.example/", "cancel-key-01");
    assert.equal(created.status, 202);
    const createdBody = await created.json();
    await ready;
    const cancelled = await fetch(`${base}/v1/jobs/${createdBody.job_ref}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const cancelledBody = await cancelled.json();
    assert.equal(cancelled.status, 202, JSON.stringify(cancelledBody));
    const body = cancelledBody;
    assert.equal(body.state, "cancelled");
    assert.equal(body.reason_code, "CANCELLED");
    assert.equal(body.report_available, false);
    const report = await fetch(`${base}/v1/jobs/${createdBody.job_ref}/report`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(report.status, 409);
    const reportBody = await report.json();
    assert.equal(reportBody.error.code, "REPORT_NOT_READY");
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("idempotency, authorization, and expiry follow the contract", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-contract-"));
  let clock = Date.parse("2026-11-22T00:00:00.000Z");
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => new Date(clock),
    lookup: async () => ["93.184.216.34"],
    run: async ({ htmlFile }) => {
      await writeFile(htmlFile, "<html>synthetic</html>");
      return crawlOk();
    },
  });
  const { base, close } = await listen(jobs);
  try {
    const missing = await post(base, "https://factory.example/", "auth-key-01", {
      authorization: { version: "2026-11-22", accepted: false, accepted_at: "2026-11-22T00:00:00.000Z", text_hash: authorizationTextHash() },
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "AUTHORIZATION_REQUIRED");

    const mismatched = await post(base, "https://factory.example/", "auth-key-01", {
      authorization: { version: "2026-11-22", accepted: true, accepted_at: "2026-11-22T00:00:00.000Z", text_hash: "0".repeat(64) },
    });
    assert.equal(mismatched.status, 400);
    assert.equal((await mismatched.json()).error.code, "AUTHORIZATION_TEXT_MISMATCH");

    const created = await post(base, "https://factory.example/products", "idem-key-01", { language: "en" });
    assert.equal(created.status, 202);
    const createdBody = await created.json();
    assert.equal(createdBody.report_language, "zh");
    const replay = await post(base, "https://factory.example/products", "idem-key-01", { language: "en" });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).job_ref, createdBody.job_ref);
    const conflict = await post(base, "https://factory.example/other", "idem-key-01", { language: "en" });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");

    const done = await waitState(base, createdBody.job_ref, "complete");
    assert.equal(done.report_available, true);
    const report = await fetch(`${base}/v1/jobs/${createdBody.job_ref}/report`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal((await report.json()).report_language, "zh");

    clock += 8 * 24 * 60 * 60 * 1000;
    const expired = await fetch(`${base}/v1/jobs/${createdBody.job_ref}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).error.code, "EXPIRED");
    const hidden = await fetch(`${base}/v1/jobs/${createdBody.job_ref}/report`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(hidden.status, 410);
    const artifact = await fetch(`${base}/v1/jobs/${createdBody.job_ref}/artifacts/html`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(artifact.status, 410);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

function listen(jobs: ReturnType<typeof createJobService>) {
  const server = createHttpServer({ token, jobs });
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, reject) => {
            server.close((error) => (error ? reject(error) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}

function post(base: string, url: string, key: string, patch: Record<string, unknown> = {}) {
  return fetch(`${base}/v1/jobs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contract_version: "vfdiag.website-diagnosis.v1",
      url,
      language: "zh",
      idempotency_key: key,
      authorization: {
        version: "2026-11-22",
        accepted: true,
        accepted_at: "2026-11-22T00:00:00.000Z",
        text_hash: authorizationTextHash(),
      },
      ...patch,
    }),
  });
}

async function waitState(base: string, jobRef: string, state: string) {
  const deadline = Date.now() + 3000;
  let body: { state?: string; report_available?: boolean } = {};
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/v1/jobs/${jobRef}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    body = await response.json();
    if (body.state === state) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${state}: ${JSON.stringify(body)}`);
}

function cancelledCrawl(): CrawlResult {
  return {
    exitCode: null,
    timedOut: false,
    cancelled: true,
    jsonText: null,
    html: null,
    errorCode: "CANCELLED",
    errorMessage: "扫描已取消。",
  };
}

function crawlOk(): CrawlResult {
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    jsonText: JSON.stringify({
      crawler: { version: "2.5.1", executedAt: "2026-11-22 20:00:00" },
      stats: { totalUrls: 3 },
      results: [
        { url: "https://factory.example/", status: "200", type: 1 },
        { url: "https://factory.example/products/valve", status: "404", type: 1 },
        { url: "https://factory.example/contact", status: "200", type: 1 },
      ],
      tables: {
        "404": { rows: [{ url: "https://factory.example/products/valve", sourceUqId: "/", statusCode: "404" }] },
        seo: { rows: [{ urlPathAndQuery: "/contact", title: "联系", h1: "联系", description: "" }] },
      },
    }),
    html: Buffer.from("<html>synthetic</html>"),
    errorCode: null,
    errorMessage: null,
  };
}
