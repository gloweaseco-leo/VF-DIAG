import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { confirmFirstReport, keepReport, specialUpgradeReport } from "./support/m1-samples.ts";

const schema = JSON.parse(
  readFileSync(new URL("../contracts/vfdiag.website-diagnosis.v1.schema.json", import.meta.url), "utf8"),
);
const report = JSON.parse(
  readFileSync(new URL("../contracts/examples/synthetic-local-optimize.report.json", import.meta.url), "utf8"),
);

function matchesType(value: unknown, typeName: string) {
  if (typeName === "null") return value === null;
  if (typeName === "array") return Array.isArray(value);
  if (typeName === "integer") return typeof value === "number" && Number.isInteger(value);
  if (typeName === "number") return typeof value === "number";
  return typeof value === typeName;
}

function check(value: unknown, node: Record<string, any>, path: string) {
  if (node.$ref) {
    const name = String(node.$ref).replace("#/$defs/", "");
    check(value, schema.$defs[name], path);
    return;
  }
  if (Object.hasOwn(node, "const")) assert.equal(value, node.const, path);
  if (node.enum) assert.equal(node.enum.includes(value), true, `${path} not in enum`);
  if (node.type) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    assert.equal(types.some((typeName: string) => matchesType(value, typeName)), true, path);
  }
  if (typeof value === "string" && typeof node.minLength === "number") {
    assert.equal(value.length >= node.minLength, true, path);
  }
  if (typeof value === "number" && typeof node.minimum === "number") {
    assert.equal(value >= node.minimum, true, path);
  }
  if (Array.isArray(value)) {
    if (typeof node.maxItems === "number") assert.equal(value.length <= node.maxItems, true, path);
    if (node.items) value.forEach((item, index) => check(item, node.items, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    const properties = node.properties ?? {};
    for (const key of node.required ?? []) {
      assert.equal(Object.hasOwn(value as object, key), true, `${path}.${key}`);
      check((value as Record<string, unknown>)[key], properties[key] ?? {}, `${path}.${key}`);
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value as object)) {
        assert.equal(Object.hasOwn(properties, key), true, `${path}.${key} extra`);
      }
    }
  }
}

test("synthetic Docker report matches the customer schema", () => {
  check(report, schema, "report");
  assert.equal(report.synthetic, true);
  assert.equal(report.product_observation.status, "OBSERVED");
  assert.equal(report.product_observation.http_status, "200");
  assert.match(report.product_observation.url, /\/products\/valve\.html$/);
  assert.equal(report.contact_observation.status, "OBSERVED");
  assert.equal(report.contact_observation.http_status, "200");
  assert.equal(report.priorities.length, 1);
  assert.match(report.priorities[0].fact, /404/);
  assert.equal(report.ai_visibility.status, "NOT_CHECKED");
  assert.match(report.ai_visibility.statement, /未检测 AI/);
  assert.equal(report.recommended_next_step, "LOCAL_OPTIMIZE");
  assert.equal(report.primary_action.label, "查看这条证据");
  assert.equal(JSON.stringify(report).includes("qualityScores"), false);
  assert.equal(report.share_blurb.includes(report.job_ref), false);
  assert.equal(report.recommended_next_step === "DISCUSS_REBUILD" || report.recommended_next_step === "SELF_FIX", false);
});

test("synthetic M1 samples cover keep, thin evidence, and linked 404s", () => {
  const cases = [
    ["synthetic-keep.report.json", keepReport(), "KEEP", "查看专业明细"],
    ["synthetic-confirm-first.report.json", confirmFirstReport(), "CONFIRM_FIRST", "查看本次范围"],
    ["synthetic-special-upgrade.report.json", specialUpgradeReport(), "SPECIAL_UPGRADE", "讨论网站升级"],
  ] as const;
  for (const [file, projected, step, label] of cases) {
    assert.equal(projected.ok, true, file);
    if (!projected.ok) continue;
    const frozen = JSON.parse(readFileSync(new URL(`../contracts/examples/${file}`, import.meta.url), "utf8"));
    check(frozen, schema, file);
    assert.deepEqual(frozen, projected.report);
    assert.equal(frozen.synthetic, true);
    assert.equal(frozen.recommended_next_step, step);
    assert.equal(frozen.primary_action.label, label);
    assert.equal(frozen.ai_visibility.status, "NOT_CHECKED");
    assert.equal(JSON.stringify(frozen).includes("qualityScores"), false);
    assert.equal(JSON.stringify(frozen).includes("DISCUSS_REBUILD"), false);
    assert.equal(JSON.stringify(frozen).includes("SELF_FIX"), false);
    assert.equal(frozen.share_blurb.includes(frozen.job_ref), false);
  }
  const keep = JSON.parse(readFileSync(new URL("../contracts/examples/synthetic-keep.report.json", import.meta.url), "utf8"));
  assert.equal(keep.priorities.length, 0);
  assert.equal(keep.headline.status, "complete");
  assert.equal(keep.product_observation.specs_status, "NEEDS_CONFIRMATION");
  const thin = JSON.parse(readFileSync(new URL("../contracts/examples/synthetic-confirm-first.report.json", import.meta.url), "utf8"));
  assert.equal(thin.product_observation.status, "NOT_CHECKED");
  assert.equal(thin.contact_observation.status, "NOT_CHECKED");
  assert.equal(thin.priorities.length, 0);
  assert.equal(thin.headline.status, "partial");
  const upgrade = JSON.parse(readFileSync(new URL("../contracts/examples/synthetic-special-upgrade.report.json", import.meta.url), "utf8"));
  assert.equal(upgrade.priorities.length, 2);
  assert.match(upgrade.priorities[0].fact, /404/);
  assert.match(upgrade.priorities[1].fact, /404/);
});

test("a failed synthetic scan does not publish a customer report", () => {
  const status = JSON.parse(readFileSync(new URL("../contracts/examples/synthetic-engine-failed.status.json", import.meta.url), "utf8"));
  for (const key of ["job_ref", "state", "reason_code", "reason", "report_available", "remaining_unknown", "synthetic", "report_language"]) {
    assert.equal(Object.hasOwn(status, key), true, key);
  }
  assert.equal(status.state, "failed");
  assert.equal(status.reason_code, "ENGINE_FAILED");
  assert.equal(status.report_available, false);
  assert.equal(status.remaining_unknown, true);
  assert.equal(status.synthetic, true);
  assert.equal("percent" in status, false);
  assert.equal("recommended_next_step" in status, false);
});
