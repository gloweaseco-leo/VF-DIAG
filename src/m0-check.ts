const base = process.env.VFDIAG_URL ?? "http://127.0.0.1:8787";
const token = process.env.VFDIAG_SERVICE_TOKEN;
const target = process.env.VFDIAG_M0_URL ?? "http://fixture-site:8080/";

if (!token) {
  console.error("缺少 VFDIAG_SERVICE_TOKEN");
  process.exit(1);
}

const { authorizationTextHash } = await import("./http/request.ts");
const created = await fetch(`${base}/v1/jobs`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    contract_version: "vfdiag.website-diagnosis.v1",
    url: target,
    language: "zh",
    idempotency_key: `m0${Date.now()}`,
    authorization: {
      version: "2026-11-22",
      accepted: true,
      accepted_at: new Date().toISOString(),
      text_hash: authorizationTextHash(),
    },
  }),
});
const createdBody = await created.json();
if (created.status !== 202) {
  console.error(created.status, createdBody);
  process.exit(1);
}
const jobRef = createdBody.job_ref as string;
const deadline = Date.now() + 180_000;
let status = createdBody;
while (!["complete", "partial", "failed", "cancelled"].includes(status.state) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const response = await fetch(`${base}/v1/jobs/${jobRef}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  status = await response.json();
}
console.log(JSON.stringify({ http: created.status, final: status }, null, 2));
if (status.state !== "complete" && status.state !== "partial") process.exit(1);
const reportResponse = await fetch(`${base}/v1/jobs/${jobRef}/report`, {
  headers: { authorization: `Bearer ${token}` },
});
const report = await reportResponse.json();
const product = report.product_observation?.status;
const contact = report.contact_observation?.status;
console.log(JSON.stringify({
  headline: report.headline,
  product,
  contact,
  next: report.recommended_next_step,
  ai: report.ai_visibility,
}, null, 2));
if (product === "NOT_CHECKED" || contact === "NOT_CHECKED") process.exit(1);
