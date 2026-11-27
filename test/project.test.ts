import assert from "node:assert/strict";
import test from "node:test";
import { projectReport } from "../src/report/project.ts";
import type { SiteOneJson } from "../src/report/types.ts";

const base = {
  jobRef: "job-test",
  inputUrl: "https://factory.example/",
  host: "factory.example",
  synthetic: true,
  generatedAt: "2026-11-22T12:00:00.000Z",
  engineVersion: "2.5.1",
};

test("projects a broken product link without calling for a rebuild", () => {
  const result = projectReport({ ...base, siteone: brokenProduct() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const report = result.report;
  assert.equal(report.product_observation.http_status, "404");
  assert.equal(report.contact_observation.http_status, "200");
  assert.equal(report.recommended_next_step, "LOCAL_OPTIMIZE");
  assert.equal(report.primary_action.label, "查看这条证据");
  assert.equal(report.ai_visibility.status, "NOT_CHECKED");
  assert.equal(report.priorities.length, 1);
  assert.match(report.priorities[0].fact, /404/);
  assert.equal(report.language_observation.cjk_chars > 0, true);
  assert.equal(JSON.stringify(report).includes("qualityScores"), false);
  assert.doesNotMatch(report.share_blurb, /job-test|token/);
});

test("a zero quality score does not change a reachable sample", () => {
  const siteone = reachable();
  const plain = projectReport({ ...base, siteone });
  const scored = projectReport({
    ...base,
    siteone: { ...siteone, qualityScores: { overall: { score: 0, label: "F" } } },
  });
  assert.equal(plain.ok && scored.ok, true);
  if (!plain.ok || !scored.ok) return;
  assert.equal(plain.report.recommended_next_step, "KEEP");
  assert.equal(scored.report.recommended_next_step, "KEEP");
  assert.equal(scored.report.product_observation.specs_status, "NEEDS_CONFIRMATION");
  assert.equal(scored.report.contact_channel_observation.channels[0].type, "email");
});

test("thin sample stays unconfirmed instead of a defect", () => {
  const result = projectReport({ ...base, siteone: thin() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.product_observation.status, "NOT_CHECKED");
  assert.equal(result.report.contact_observation.status, "NOT_CHECKED");
  assert.equal(result.report.recommended_next_step, "CONFIRM_FIRST");
  assert.equal(result.report.priorities.length, 0);
  assert.equal(result.report.headline.status, "partial");
});

test("an http site on the same host keeps the existing diagnosis", () => {
  const siteone = reachable();
  siteone.results = (siteone.results ?? []).map((row) => ({
    ...row,
    url: String(row.url).replace("https://", "http://"),
  }));
  siteone.results.push({ url: "https://factory.example/about", status: "200", type: 1 });
  const result = projectReport({ ...base, inputUrl: "http://factory.example/", siteone });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.target.input_url, "http://factory.example/");
  assert.equal(result.report.recommended_next_step, "KEEP");
});

test("refuses a report when a fetched URL leaves the target host", () => {
  const siteone = thin();
  siteone.results?.push({ url: "http://169.254.169.254/latest", status: "200", type: 1 });
  const result = projectReport({ ...base, siteone });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "UNSAFE_OFFHOST");
});

function brokenProduct(): SiteOneJson {
  return {
    crawler: { version: "2.5.1", executedAt: "2026-11-22 20:00:00" },
    stats: { totalUrls: 3 },
    results: [
      { url: "https://factory.example/", status: "200", type: 1 },
      { url: "https://factory.example/products/valve", status: "404", type: 1 },
      { url: "https://factory.example/contact", status: "200", type: 1 },
    ],
    tables: {
      "404": {
        rows: [{ statusCode: "404", url: "https://factory.example/products/valve", sourceUqId: "/" }],
      },
      seo: {
        rows: [
          { urlPathAndQuery: "/", title: "阀门厂", h1: "阀门厂", description: "工业阀门", robotsIndex: "1" },
          { urlPathAndQuery: "/contact", title: "联系我们", h1: "联系", description: "", robotsIndex: "1" },
        ],
      },
    },
    qualityScores: { overall: { score: 9.8 } },
  };
}

function reachable(): SiteOneJson {
  return {
    crawler: { version: "2.5.1", executedAt: "2026-11-22 20:00:00" },
    stats: { totalUrls: 2 },
    results: [
      { url: "https://factory.example/products/valve", status: "200", type: 1 },
      { url: "https://factory.example/contact", status: "200", type: 1 },
    ],
    tables: {
      seo: {
        rows: [
          {
            urlPathAndQuery: "/products/valve",
            title: "闸阀 Z41H",
            h1: "闸阀",
            description: "公称压力 1.6MPa",
            robotsIndex: "1",
          },
          { urlPathAndQuery: "/contact", title: "Contact", h1: "Contact", description: "", robotsIndex: "1" },
        ],
      },
      "external-urls": { rows: [{ url: "mailto:sales@factory.example", count: "1" }] },
    },
  };
}

function thin(): SiteOneJson {
  return {
    crawler: { version: "2.5.1", executedAt: "2026-11-22 20:00:00" },
    stats: { totalUrls: 1 },
    results: [{ url: "https://factory.example/", status: "200", type: 1 }],
    tables: {
      seo: { rows: [{ urlPathAndQuery: "/", title: "Home", h1: "", description: "", robotsIndex: "1" }] },
    },
  };
}
