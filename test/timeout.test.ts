import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runSiteOne } from "../src/siteone/run.ts";

const target = {
  href: "https://factory.example/",
  origin: "https://factory.example",
  host: "factory.example",
  port: 443,
  addresses: ["93.184.216.34"],
  synthetic: false,
};

test("wall clock kills a crawler that does not exit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-timeout-"));
  const controller = new AbortController();
  try {
    const result = await runSiteOne({
      bin: process.execPath,
      target,
      jsonFile: path.join(dir, "siteone.json"),
      htmlFile: path.join(dir, "siteone.html"),
      signal: controller.signal,
      wallClockMs: 400,
      command: { bin: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
    });
    assert.equal(result.errorCode, "ENGINE_TIMEOUT");
    assert.equal(result.timedOut, true);
    assert.equal(result.jsonText, null);
  } finally {
    controller.abort();
    await rm(dir, { recursive: true, force: true });
  }
});
