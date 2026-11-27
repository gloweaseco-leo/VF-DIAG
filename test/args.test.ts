import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildSiteOneArgs, FORBIDDEN_ARG_PATTERN } from "../src/siteone/args.ts";
import type { ResolvedTarget } from "../src/safety/target.ts";

const target: ResolvedTarget = {
  href: "https://factory.example/",
  origin: "https://factory.example",
  host: "factory.example",
  port: 443,
  addresses: ["93.184.216.34"],
  synthetic: false,
};

test("crawler arguments stay inside the M0 allowlist", () => {
  const args = buildSiteOneArgs(target, {
    jsonFile: "/tmp/job/siteone.json",
    htmlFile: "/tmp/job/siteone.html",
  });
  assert.equal(args.some((arg) => FORBIDDEN_ARG_PATTERN.test(arg)), false);
  assert.ok(args.includes("--max-visited-urls=50"));
  assert.ok(args.includes("--max-depth=3"));
  assert.ok(args.includes("--max-reqs-per-sec=1"));
  assert.ok(args.includes("--workers=1"));
  assert.ok(args.includes("--allowed-domain-for-crawling=factory.example"));
  assert.ok(args.includes("--resolve=factory.example:443:93.184.216.34"));
  const storageDir = path.join(path.dirname("/tmp/job/siteone.json"), "tmp", "result-storage");
  assert.ok(args.includes(`--result-storage-dir=${storageDir}`));
  assert.ok(args.includes("--http-cache-dir=off"));
  assert.equal(args.some((arg) => arg.includes("--ai-")), false);
  assert.equal(args.some((arg) => arg.includes("--browser")), false);
});
