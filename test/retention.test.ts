import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizationTextHash } from "../src/http/request.ts";
import { createJobService } from "../src/jobs/service.ts";
import type { CrawlResult } from "../src/siteone/run.ts";

test("expiry deletes scan artifacts and restart deletes them again", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-expire-"));
  let clock = Date.parse("2026-11-22T00:00:00.000Z");
  const options = {
    dataDir: dir,
    syntheticHosts: new Set<string>(),
    now: () => new Date(clock),
    lookup: async () => ["93.184.216.34"],
    run: writeCrawl,
  };
  try {
    const first = createJobService(options);
    const created = await first.create(body("expire-key-01"));
    assert.equal(created.status, 202);
    const jobRef = (created.body as { job_ref: string }).job_ref;
    await waitComplete(first, jobRef);
    await assertArtifacts(dir, jobRef, true);

    const early = createJobService(options);
    await early.recover();
    await assertArtifacts(dir, jobRef, true);
    assert.equal((await early.get(jobRef)).status, 200);

    clock += 8 * 24 * 60 * 60 * 1000;
    const expired = await first.get(jobRef);
    assert.equal(expired.status, 410);
    await assertArtifacts(dir, jobRef, false);
    await access(path.join(dir, "jobs", jobRef, "job.json"));

    await writeFile(path.join(dir, "jobs", jobRef, "siteone.html"), "<html>leftover</html>");
    await writeFile(path.join(dir, "jobs", jobRef, "report.json"), "{}");
    const restarted = createJobService(options);
    await restarted.recover();
    await assertArtifacts(dir, jobRef, false);
    assert.equal((await restarted.get(jobRef)).status, 410);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the local placeholder token is refused for a remote process", async () => {
  const { assertServiceToken, LOCAL_DEV_TOKEN } = await import("../src/http/request.ts");
  assert.throws(() => assertServiceToken(LOCAL_DEV_TOKEN), /随机凭据/);
  assert.equal(assertServiceToken(LOCAL_DEV_TOKEN, { localOnly: true }), LOCAL_DEV_TOKEN);
  assert.equal(assertServiceToken("remote-random-token-value"), "remote-random-token-value");
  assert.throws(() => assertServiceToken(LOCAL_DEV_TOKEN, { localOnly: true, funnel: true }), /Funnel/);
  assert.throws(() => assertServiceToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { funnel: true }), /Funnel/);
  const issued = "vfdiag-funnel-token-2026-11-23-independent";
  assert.equal(assertServiceToken(issued, { funnel: true }), issued);
});

async function waitComplete(jobs: ReturnType<typeof createJobService>, jobRef: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const got = await jobs.get(jobRef);
    const body = got.body as { state?: string };
    if (body.state === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("job did not complete");
}

async function assertArtifacts(dir: string, jobRef: string, present: boolean) {
  for (const name of ["siteone.html", "siteone.json", "report.json"]) {
    const file = path.join(dir, "jobs", jobRef, name);
    if (present) await access(file);
    else await assert.rejects(access(file));
  }
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
      accepted_at: "2026-11-22T00:00:00.000Z",
      text_hash: authorizationTextHash(),
    },
  };
}

async function writeCrawl(options: { htmlFile: string; jsonFile: string }): Promise<CrawlResult> {
  const jsonText = JSON.stringify({
    crawler: { version: "2.5.1", executedAt: "2026-11-22 20:00:00" },
    stats: { totalUrls: 2 },
    results: [
      { url: "https://factory.example/products/valve", status: "200", type: 1 },
      { url: "https://factory.example/contact", status: "200", type: 1 },
    ],
    tables: {
      seo: {
        rows: [
          { urlPathAndQuery: "/products/valve", title: "闸阀", h1: "闸阀", description: "合成规格", robotsIndex: "1" },
          { urlPathAndQuery: "/contact", title: "联系", h1: "联系", description: "", robotsIndex: "1" },
        ],
      },
    },
  });
  await writeFile(options.htmlFile, "<html>synthetic</html>");
  await writeFile(options.jsonFile, jsonText);
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    jsonText,
    html: Buffer.from("<html>synthetic</html>"),
    errorCode: null,
    errorMessage: null,
  };
}
