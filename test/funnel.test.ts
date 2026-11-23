import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { accessLog, redactSecrets } from "../src/http/redact.ts";
import { createHttpServer } from "../src/http/server.ts";
import { createJobService } from "../src/jobs/service.ts";

test("access logs drop the bearer token", () => {
  const secret = "vfdiag-funnel-token-2026-11-23-independent";
  const line = accessLog("GET", `/v1/jobs?token=${secret}`, 401, secret);
  assert.equal(line.includes(secret), false);
  assert.equal(line.includes("?"), false);
  assert.equal(redactSecrets(`Bearer ${secret} failed`, [secret]), "Bearer [redacted] failed");
});

test("funnel mode limits repeated callers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-rate-"));
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    lookup: async () => ["93.184.216.34"],
    run: async () => {
      throw new Error("not used");
    },
  });
  const server = createHttpServer({ token: "vfdiag-funnel-token-2026-11-23-independent", jobs, ratePerMinute: 2 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
    const limited = await fetch(`${base}/v1/health`);
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.error.code, "RATE_LIMIT");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await rm(dir, { recursive: true, force: true });
  }
});
