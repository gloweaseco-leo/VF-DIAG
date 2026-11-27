import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authorizationTextHash } from "../src/http/request.ts";
import { createJobService } from "../src/jobs/service.ts";

test("a connection failure does not publish a customer report", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-conn-"));
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async () => ["93.184.216.34"],
    run: async () => ({
      exitCode: 3,
      timedOut: false,
      cancelled: false,
      jsonText: JSON.stringify({
        crawler: { version: "2.5.1", executedAt: "2026-11-23 09:41:10" },
        stats: { totalUrls: 1 },
        results: [{ url: "https://factory.example/", status: "-1:CONN-FAIL", type: 10 }],
      }),
      html: Buffer.from(""),
      errorCode: null,
      errorMessage: null,
    }),
  });
  await jobs.recover();
  try {
    const created = await jobs.create({
      contract_version: "vfdiag.website-diagnosis.v1",
      url: "https://factory.example/",
      language: "zh",
      idempotency_key: "connect-fail-key",
      authorization: {
        version: "2026-11-22",
        accepted: true,
        accepted_at: "2026-11-23T09:41:00.000Z",
        text_hash: authorizationTextHash(),
      },
    });
    assert.equal(created.status, 202);
    const jobRef = (created.body as { job_ref: string }).job_ref;
    const final = await waitFailed(jobs, jobRef);
    assert.equal(final.reason_code, "TARGET_UNREACHABLE");
    assert.equal(final.report_available, false);
    const report = await jobs.report(jobRef);
    assert.equal(report.status, 409);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitFailed(jobs: ReturnType<typeof createJobService>, jobRef: string) {
  const deadline = Date.now() + 3000;
  let body: { state?: string; reason_code?: string; report_available?: boolean } = {};
  while (Date.now() < deadline) {
    const got = await jobs.get(jobRef);
    body = got.body as typeof body;
    if (body.state === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${JSON.stringify(body)}`);
}
