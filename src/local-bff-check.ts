import { authorizationTextHash, LOCAL_DEV_TOKEN } from "./http/request.ts";

const base = process.env.VFDIAG_URL ?? "http://127.0.0.1:8787";
const token = process.env.VFDIAG_SERVICE_TOKEN ?? LOCAL_DEV_TOKEN;
const auth = {
  version: "2026-11-22",
  accepted: true,
  accepted_at: "2026-11-23T04:00:00.000Z",
  text_hash: authorizationTextHash(),
};

const notes: string[] = [];

function pass(name: string, detail: unknown) {
  notes.push(JSON.stringify({ name, ok: true, detail }));
}

function fail(name: string, detail: unknown): never {
  console.error(JSON.stringify({ name, ok: false, detail }, null, 2));
  process.exit(1);
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
  const body = type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body };
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
  let body: { state?: string; reason_code?: string; report_available?: boolean; synthetic?: boolean; report_language?: string; remaining_unknown?: boolean } = {};
  while (Date.now() < deadline) {
    const response = await request(`/v1/jobs/${jobRef}`, { token });
    body = response.body as typeof body;
    if (["complete", "partial", "failed", "cancelled", "expired"].includes(body.state ?? "")) return { status: response.status, body };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { status: 0, body };
}

const health = await request("/v1/health");
if (health.status !== 200) fail("health", health.status);
pass("health", { status: health.status, engine_version: (health.body as { engine_version?: string }).engine_version });

const missing = await request("/v1/jobs", { method: "POST", token: null, body: jobBody("https://factory.example/", "local-bff-unauth") });
if (missing.status !== 401) fail("missing_token", missing.status);
pass("missing_token", { status: 401, code: (missing.body as { error?: { code?: string } }).error?.code });

const wrong = await request("/v1/jobs", { method: "POST", token: "wrong-token-value-xxxx", body: jobBody("https://factory.example/", "local-bff-wrong") });
if (wrong.status !== 401) fail("wrong_token", wrong.status);
pass("wrong_token", { status: 401 });

const blocked = await request("/v1/jobs", { method: "POST", token, body: jobBody("https://127.0.0.1/", `local-bff-private-${Date.now()}`) });
if (blocked.status !== 202) fail("private_create", { status: blocked.status, body: blocked.body });
const blockedFinal = await wait((blocked.body as { job_ref: string }).job_ref);
if (blockedFinal.body.reason_code !== "TARGET_PRIVATE_ADDRESS") fail("private_final", blockedFinal.body);
pass("private_target", { state: blockedFinal.body.state, reason_code: blockedFinal.body.reason_code });

const key = `local-bff-scan-${Date.now()}`;
const created = await request("/v1/jobs", { method: "POST", token, body: jobBody("http://fixture-site:8080/", key) });
if (created.status !== 202) fail("create", { status: created.status, body: created.body });
const jobRef = (created.body as { job_ref: string }).job_ref;
const busy = await request("/v1/jobs", { method: "POST", token, body: jobBody("http://fixture-site:8080/contact.html", `local-bff-busy-${Date.now()}`) });
if (busy.status !== 429) fail("capacity", { status: busy.status, body: busy.body });
pass("capacity", { status: 429, code: (busy.body as { error?: { code?: string } }).error?.code });

const done = await wait(jobRef);
if (done.body.state !== "complete" && done.body.state !== "partial") fail("scan", done.body);
if (done.body.report_language !== "zh" || done.body.remaining_unknown !== true || done.body.synthetic !== true) fail("status_fields", done.body);

const replay = await request("/v1/jobs", { method: "POST", token, body: jobBody("http://fixture-site:8080/", key) });
if (replay.status !== 200 || (replay.body as { job_ref?: string }).job_ref !== jobRef) fail("idempotent_replay", replay.body);
const conflict = await request("/v1/jobs", { method: "POST", token, body: jobBody("http://fixture-site:8080/contact.html", key) });
if (conflict.status !== 409) fail("idempotent_conflict", { status: conflict.status, body: conflict.body });
pass("idempotency", { replay: 200, conflict: 409 });

const report = await request(`/v1/jobs/${jobRef}/report`, { token });
const reportBody = report.body as {
  headline?: { status?: string };
  report_language?: string;
  synthetic?: boolean;
  product_observation?: { status?: string };
  contact_observation?: { status?: string };
  recommended_next_step?: string;
  ai_visibility?: { status?: string };
  share_blurb?: string;
};
if (report.status !== 200) fail("report", report.status);
if (reportBody.report_language !== "zh" || reportBody.synthetic !== true) fail("report_flags", reportBody);
if (reportBody.product_observation?.status === "NOT_CHECKED" || reportBody.contact_observation?.status === "NOT_CHECKED") {
  fail("observations", reportBody);
}
if (reportBody.share_blurb?.includes(jobRef)) fail("share_blurb_leaks_ref", true);
pass("report", {
  job_state: done.body.state,
  headline_status: reportBody.headline?.status,
  product: reportBody.product_observation?.status,
  contact: reportBody.contact_observation?.status,
  next: reportBody.recommended_next_step,
  ai: reportBody.ai_visibility?.status,
});

for (const kind of ["html", "json"] as const) {
  const artifact = await request(`/v1/jobs/${jobRef}/artifacts/${kind}`, { token });
  const disposition = artifact.headers.get("content-disposition") ?? "";
  const nosniff = artifact.headers.get("x-content-type-options");
  if (artifact.status !== 200 || !disposition.includes("attachment") || nosniff !== "nosniff") {
    fail(`artifact_${kind}`, { status: artifact.status, disposition, nosniff });
  }
  const size = Buffer.isBuffer(artifact.body) ? artifact.body.byteLength : 0;
  pass(`artifact_${kind}`, { status: 200, bytes: size, disposition });
}

const cancelKey = `local-bff-cancel-${Date.now()}`;
const cancelCreate = await request("/v1/jobs", { method: "POST", token, body: jobBody("http://fixture-site:8080/", cancelKey) });
if (cancelCreate.status !== 202) fail("cancel_create", cancelCreate.body);
const cancelRef = (cancelCreate.body as { job_ref: string }).job_ref;
const cancel = await request(`/v1/jobs/${cancelRef}/cancel`, { method: "POST", token });
const cancelFinal = await wait(cancelRef);
if (cancel.status !== 202 && cancelFinal.body.state !== "cancelled") fail("cancel", { status: cancel.status, body: cancel.body, final: cancelFinal.body });
const hidden = await request(`/v1/jobs/${cancelRef}/report`, { token });
if (cancelFinal.body.state === "cancelled" && hidden.status !== 409) fail("cancel_report", hidden.status);
pass("cancel", { http: cancel.status, state: cancelFinal.body.state, report_status: hidden.status });

console.log(notes.map((line) => JSON.parse(line)).map((item) => `${item.name} ok`).join("\n"));
console.log(JSON.stringify({
  job_state: done.body.state,
  headline_status: reportBody.headline?.status,
  product: reportBody.product_observation?.status,
  contact: reportBody.contact_observation?.status,
  next: reportBody.recommended_next_step,
  cancel_state: cancelFinal.body.state,
}, null, 2));
