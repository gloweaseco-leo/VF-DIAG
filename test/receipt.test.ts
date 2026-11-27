import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectReceipt } from "./support/api-receipt.ts";

test("redacted local API receipt stays aligned with the server", async () => {
  const live = await collectReceipt();
  const frozen = JSON.parse(readFileSync(new URL("../contracts/examples/api-receipt.json", import.meta.url), "utf8"));
  assert.deepEqual(live, frozen);
  const calls = live.calls as Array<{ name: string; status: number; body: { state?: string; error?: { code?: string }; headline?: { status?: string }; remaining_unknown?: boolean } }>;
  const byName = Object.fromEntries(calls.map((item) => [item.name, item]));
  assert.equal(byName.reject_missing_authorization.status, 400);
  assert.equal(byName.reject_missing_authorization.body.error?.code, "AUTHORIZATION_REQUIRED");
  assert.equal(byName.private_target_final.body.state, "failed");
  assert.equal(byName.report_job_status.body.state, "complete");
  assert.equal(byName.report_job_status.body.remaining_unknown, true);
  assert.equal(byName.read_report.body.headline?.status, "partial");
  assert.equal(byName.read_report.body.report_language, "zh");
  assert.equal(byName.download_html.status, 200);
  assert.equal(byName.download_json.status, 200);
  assert.equal(byName.cancel_job.body.state, "cancelled");
  assert.equal(byName.report_after_cancel.status, 409);
  assert.equal(byName.expired_status.status, 410);
  assert.equal(byName.expired_html.status, 410);
  assert.equal(JSON.stringify(live).includes(tokenLeak), false);
});

const tokenLeak = "local-test-token-value";
