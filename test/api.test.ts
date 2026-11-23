import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizationTextHash } from "../src/http/request.ts";
import { createHttpServer } from "../src/http/server.ts";
import { createJobService } from "../src/jobs/service.ts";
import type { CrawlResult } from "../src/siteone/run.ts";
import { killProcessTree, spawnCrawler } from "../src/siteone/process.ts";

const token = "local-test-token-value";

test("api rejects private targets and serves a projected report", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-"));
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async (host) => {
      if (host === "factory.example") return ["93.184.216.34"];
      throw new Error("nxdomain");
    },
    run: async ({ htmlFile }) => {
      await writeFile(htmlFile, "<html>synthetic</html>");
      return crawlOk();
    },
  });
  await jobs.recover();
  const server = createHttpServer({ token, jobs });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const denied = await fetch(`${base}/v1/health`);
    assert.equal(denied.status, 200);
    const unauth = await fetch(`${base}/v1/jobs`, { method: "POST" });
    assert.equal(unauth.status, 401);
    const blocked = await post(base, "https://127.0.0.1/", "blocked-key-01");
    assert.equal(blocked.status, 202);
    const blockedBody = await blocked.json();
    const blockedFinal = await waitState(base, blockedBody.job_ref, "failed");
    assert.equal(blockedFinal.reason_code, "TARGET_PRIVATE_ADDRESS");
    const created = await post(base, "https://factory.example/products", "factory-key-01");
    assert.equal(created.status, 202);
    const createdBody = await created.json();
    assert.equal(createdBody.remaining_unknown, true);
    assert.equal("percent" in createdBody, false);
    const done = await waitState(base, createdBody.job_ref, "complete");
    assert.equal(done.report_available, true);
    const reportResponse = await fetch(`${base}/v1/jobs/${createdBody.job_ref}/report`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const report = await reportResponse.json();
    assert.equal(report.recommended_next_step, "LOCAL_OPTIMIZE");
    assert.equal(report.report_language, "zh");
    const artifact = await fetch(`${base}/v1/jobs/${createdBody.job_ref}/artifacts/html`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.match(artifact.headers.get("content-disposition") ?? "", /attachment/);
  } finally {
    await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
    await rm(dir, { recursive: true, force: true });
  }
});

test("one active job is the whole M0 capacity", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-cap-"));
  let release: (result: CrawlResult) => void = () => {};
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async () => ["93.184.216.34"],
    run: () =>
      new Promise((resolve) => {
        release = resolve;
        markReady();
      }),
  });
  const server = createHttpServer({ token, jobs });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const first = await post(base, "https://factory.example/", "capacity-key-01");
    assert.equal(first.status, 202);
    await ready;
    const second = await post(base, "https://factory.example/other", "capacity-key-02");
    assert.equal(second.status, 429);
    release(crawlOk());
    const firstBody = await first.json();
    await waitState(base, firstBody.job_ref, "complete");
  } finally {
    await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
    await rm(dir, { recursive: true, force: true });
  }
});

test("process tree kill stops a child", async () => {
  const child = spawnCrawler(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await killProcessTree(child);
  const result = await Promise.race([
    exited,
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((_, reject) => {
      setTimeout(() => reject(new Error("进程树没有在 3 秒内退出")), 3000);
    }),
  ]);
  assert.equal(result.code !== null || result.signal !== null, true);
});

function post(base: string, url: string, key = "idem-key-01") {
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
        accepted_at: "2026-11-22T12:00:00.000Z",
        text_hash: authorizationTextHash(),
      },
    }),
  });
}

async function waitState(base: string, jobRef: string, state: string) {
  const deadline = Date.now() + 3000;
  let body: { state?: string; reason_code?: string; report_available?: boolean } = {};
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
        seo: {
          rows: [
            { urlPathAndQuery: "/", title: "阀门厂", h1: "阀门厂", description: "工业阀门" },
            { urlPathAndQuery: "/contact", title: "联系", h1: "联系", description: "" },
          ],
        },
      },
    }),
    html: Buffer.from("<html>synthetic</html>"),
    errorCode: null,
    errorMessage: null,
  };
}
