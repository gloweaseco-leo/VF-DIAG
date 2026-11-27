import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { authorizationTextHash } from "./http/request.ts";
import { evaluateTarget } from "./safety/target.ts";

const exec = promisify(execFile);
const base = process.env.VFDIAG_URL ?? "";
if (!base.startsWith("https://")) {
  console.error("Set VFDIAG_URL to the Tailscale Funnel https origin.");
  process.exit(1);
}

const envText = await readFile(new URL("../.env", import.meta.url), "utf8");
const token = envText.match(/^VFDIAG_SERVICE_TOKEN=(.*)$/m)?.[1]?.trim() ?? "";
if (token.length < 32 || token === "local-docker-dev-token-change-me") {
  console.error("Refusing to call Funnel without an independent token in .env.");
  process.exit(1);
}

const auth = {
  version: "2026-11-22",
  accepted: true,
  accepted_at: "2026-11-23T07:00:00.000Z",
  text_hash: authorizationTextHash(),
};
const checks: Array<{ name: string; ok: boolean; detail: unknown }> = [];

function record(name: string, ok: boolean, detail: unknown) {
  checks.push({ name, ok, detail });
  if (!ok) {
    console.error(JSON.stringify({ name, ok, detail }, null, 2));
    process.exitCode = 1;
  }
}

async function request(path: string, options: { method?: string; token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
}

function jobBody(url: string, key: string) {
  return {
    contract_version: "vfdiag.website-diagnosis.v1",
    url,
    language: "en",
    idempotency_key: key,
    authorization: auth,
  };
}

async function wait(jobRef: string) {
  const deadline = Date.now() + 180_000;
  let last: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  while (Date.now() < deadline) {
    const response = await request(`/v1/jobs/${jobRef}`, { token });
    last = { status: response.status, body: response.body as Record<string, unknown> };
    if (["complete", "partial", "failed", "cancelled", "expired"].includes(String(last.body.state ?? ""))) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last;
}

function redactJob(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll(token, "[redacted]"));
}

const health = await request("/v1/health");
record("health", health.status === 200 && (health.body as { status?: string }).status === "ok", {
  status: health.status,
  engine_version: (health.body as { engine_version?: string }).engine_version,
});

const missing = await request("/v1/jobs", { method: "POST", token: null, body: jobBody("http://fixture-site:8080/", `i2-unauth-${Date.now()}`) });
record("missing_token", missing.status === 401, { status: missing.status, code: (missing.body as { error?: { code?: string } }).error?.code });

const wrong = await request("/v1/jobs", {
  method: "POST",
  token: "wrong-token-value-not-the-real-one",
  body: jobBody("http://fixture-site:8080/", `i2-wrong-${Date.now()}`),
});
record("wrong_token", wrong.status === 401, { status: wrong.status });

const egress = await exec(
  "docker",
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.synthetic.yml",
    "-f",
    "docker-compose.funnel.yml",
    "exec",
    "-T",
    "-u",
    "node",
    "worker",
    "node",
    "--input-type=module",
    "-e",
    `const targets = [["metadata","http://169.254.169.254/latest/meta-data/"],["loopback","http://127.0.0.1:8787/v1/health"],["rfc1918","http://10.1.1.1/"],["cgnat","http://100.64.0.2/"],["mapped","http://[::ffff:169.254.169.254]/"],["fixture","http://fixture-site:8080/"]];
const out = {};
for (const [name, url] of targets) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "manual" });
    out[name] = { reached: true, status: response.status, ms: Date.now() - started };
  } catch (error) {
    const cause = error && error.cause && error.cause.code ? error.cause.code : error.name;
    out[name] = { reached: false, error: String(cause), ms: Date.now() - started };
  }
}
console.log(JSON.stringify(out));`,
  ],
  { cwd: new URL("..", import.meta.url), windowsHide: true },
);
const egressBody = JSON.parse(egress.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, { reached: boolean; status?: number }>;
record("egress_blocks_private", ["metadata", "loopback", "rfc1918", "cgnat", "mapped"].every((name) => egressBody[name]?.reached === false), egressBody);
record("egress_allows_fixture", egressBody.fixture?.reached === true && egressBody.fixture.status === 200, egressBody.fixture ?? null);

const created = await request("/v1/jobs", {
  method: "POST",
  token,
  body: jobBody("http://fixture-site:8080/", `i2-synthetic-${Date.now()}`),
});
const syntheticRef = (created.body as { job_ref?: string }).job_ref ?? "";
const synthetic = created.status === 202 ? await wait(syntheticRef) : { status: created.status, body: created.body as Record<string, unknown> };
let reportOk = false;
if (synthetic.body.report_available === true) {
  const report = await request(`/v1/jobs/${syntheticRef}/report`, { token });
  const reportBody = report.body as { report_language?: string; synthetic?: boolean; share_blurb?: string };
  reportOk =
    report.status === 200 &&
    reportBody.report_language === "zh" &&
    reportBody.synthetic === true &&
    !String(reportBody.share_blurb ?? "").includes(syntheticRef);
}
record("synthetic_diagnosis", created.status === 202 && ["complete", "partial"].includes(String(synthetic.body.state)) && reportOk, {
  create_status: created.status,
  state: synthetic.body.state,
  headline_status: undefined,
  report_available: synthetic.body.report_available,
});

const redirectCreated = await request("/v1/jobs", {
  method: "POST",
  token,
  body: jobBody("http://fixture-site:8080/redirect-metadata", `i2-redirect-${Date.now()}`),
});
const redirectRef = (redirectCreated.body as { job_ref?: string }).job_ref ?? "";
const redirect = redirectCreated.status === 202 ? await wait(redirectRef) : { status: redirectCreated.status, body: redirectCreated.body as Record<string, unknown> };
const redirectReport = await request(`/v1/jobs/${redirectRef}/report`, { token });
const redirectText = JSON.stringify(redirectReport.body);
record(
  "redirect_does_not_publish_metadata",
  !redirectText.includes("ami-id") &&
    (redirect.body.report_available === true
      ? !redirectText.includes("169.254.169.254")
      : redirectReport.status === 409),
  { state: redirect.body.state, reason_code: redirect.body.reason_code, report_status: redirectReport.status, report_available: redirect.body.report_available },
);

const subCreated = await request("/v1/jobs", {
  method: "POST",
  token,
  body: jobBody("http://fixture-site:8080/subresource.html", `i2-sub-${Date.now()}`),
});
const subRef = (subCreated.body as { job_ref?: string }).job_ref ?? "";
const sub = subCreated.status === 202 ? await wait(subRef) : { status: subCreated.status, body: subCreated.body as Record<string, unknown> };
let subClean = sub.body.report_available !== true;
if (sub.body.report_available === true) {
  const report = await request(`/v1/jobs/${subRef}/report`, { token });
  subClean = !JSON.stringify(report.body).includes("169.254.169.254");
}
record("subresource_stays_on_host", subClean, { state: sub.body.state, reason_code: sub.body.reason_code, report_available: sub.body.report_available });

const privateFiles = await exec(
  "docker",
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.synthetic.yml",
    "-f",
    "docker-compose.funnel.yml",
    "exec",
    "-T",
    "-u",
    "node",
    "worker",
    "node",
    "--input-type=module",
    "-e",
    `import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
async function walk(dir, acc = []) {
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) await walk(full, acc);
    else acc.push(full);
  }
  return acc;
}
const files = await walk("/var/lib/vfdiag");
let urlHits = 0;
let bodyHits = 0;
for (const file of files) {
  if (!file.endsWith(".json") && !file.endsWith(".html")) continue;
  const text = await readFile(file, "utf8");
  if (text.includes("169.254.169.254")) urlHits += 1;
  if (text.includes("ami-id") || text.includes("instance-id")) bodyHits += 1;
}
console.log(JSON.stringify({ url_hits: urlHits, metadata_body_hits: bodyHits }));`,
  ],
  { cwd: new URL("..", import.meta.url), windowsHide: true },
);
const stored = JSON.parse(privateFiles.stdout.trim().split("\n").at(-1) ?? "{}") as { metadata_body_hits?: number; url_hits?: number };
record("stored_files_have_no_metadata_body", stored.metadata_body_hits === 0, stored);

const mixed = await evaluateTarget("https://rebind.example/", {
  lookup: async () => ["93.184.216.34", "169.254.169.254"],
  syntheticHosts: new Set(),
});
record("dns_mixed_answer_rejected", !mixed.ok && mixed.code === "TARGET_PRIVATE_ADDRESS", mixed.ok ? {} : { code: mixed.code });

let timeoutExit = 1;
try {
  await exec("node", ["--experimental-strip-types", "--test", "test/timeout.test.ts"], {
    cwd: new URL("..", import.meta.url),
    windowsHide: true,
  });
  timeoutExit = 0;
} catch {
  timeoutExit = 1;
}
record("wall_clock_kill", timeoutExit === 0, { exit: timeoutExit });

await exec(
  "docker",
  ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.synthetic.yml", "-f", "docker-compose.funnel.yml", "pause", "fixture-site"],
  { cwd: new URL("..", import.meta.url), windowsHide: true },
);
let recovery: Record<string, unknown> = {};
try {
  const hanging = await request("/v1/jobs", {
    method: "POST",
    token,
    body: jobBody("http://fixture-site:8080/", `i2-recover-${Date.now()}`),
  });
  const hangingRef = (hanging.body as { job_ref?: string }).job_ref ?? "";
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await exec(
    "docker",
    ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.synthetic.yml", "-f", "docker-compose.funnel.yml", "restart", "worker"],
    { cwd: new URL("..", import.meta.url), windowsHide: true },
  );
  const healthDeadline = Date.now() + 60_000;
  let healthAgain = 0;
  while (Date.now() < healthDeadline) {
    try {
      const again = await request("/v1/health");
      healthAgain = again.status;
      if (again.status === 200) break;
    } catch {
      healthAgain = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const recovered = hangingRef ? await request(`/v1/jobs/${hangingRef}`, { token }) : { status: 0, body: {} };
  recovery = {
    health_after_restart: healthAgain,
    state: (recovered.body as { state?: string }).state,
    reason_code: (recovered.body as { reason_code?: string }).reason_code,
  };
  record(
    "restart_recovery",
    healthAgain === 200 && (recovered.body as { reason_code?: string }).reason_code === "WORKER_RESTARTED",
    recovery,
  );
} finally {
  await exec(
    "docker",
    ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.synthetic.yml", "-f", "docker-compose.funnel.yml", "unpause", "fixture-site"],
    { cwd: new URL("..", import.meta.url), windowsHide: true },
  );
}

const receipt = {
  kind: "vfdiag.i2-funnel-receipt",
  checked_at: new Date().toISOString(),
  https_origin: base,
  credential: {
    name: "VFDIAG_SERVICE_TOKEN",
    location: "gitignored .env on the worker host, and the Vercel Preview environment variable of the same name",
    printed: false,
    vrae_key_reused: false,
    placeholder_accepted: false,
  },
  publish: "Tailscale Funnel HTTPS to 127.0.0.1:8787. Host port 8787 is not published on 0.0.0.0.",
  checks: checks.map((check) => ({ ...check, detail: redactJob(check.detail) })),
};
await writeFile(new URL("../contracts/examples/i2-funnel-receipt.json", import.meta.url), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ok: process.exitCode !== 1, https_origin: base, checks: checks.map((check) => check.name) }, null, 2));
if (process.exitCode === 1) process.exit(1);
