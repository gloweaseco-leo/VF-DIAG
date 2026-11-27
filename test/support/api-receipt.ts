import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTHORIZATION_STATEMENT, AUTHORIZATION_VERSION, MODEL_AUTHORIZATION_STATEMENT, MODEL_AUTHORIZATION_VERSION } from "../../src/constants.ts";
import { authorizationTextHash, modelAuthorizationTextHash } from "../../src/http/request.ts";
import { createHttpServer } from "../../src/http/server.ts";
import { createJobService } from "../../src/jobs/service.ts";
import type { CrawlResult } from "../../src/siteone/run.ts";

const token = "local-test-token-value";

export async function collectReceipt() {
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-receipt-"));
  let clock = Date.parse("2026-11-23T02:00:00.000Z");
  let releaseSlow: () => void = () => {};
  const jobs = createJobService({
    dataDir: dir,
    syntheticHosts: new Set(),
    now: () => new Date(clock),
    lookup: async (host) => {
      if (host === "factory.example") return ["93.184.216.34"];
      throw new Error("nxdomain");
    },
    run: (options) => {
      if (options.target.href.includes("/slow")) {
        return new Promise((resolve) => {
          releaseSlow = () => resolve(cancelledCrawl());
          if (options.signal.aborted) releaseSlow();
          else options.signal.addEventListener("abort", releaseSlow, { once: true });
        });
      }
      return writeCrawl(options);
    },
  });
  const server = createHttpServer({ token, jobs });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  const calls: Array<{ name: string; method: string; path: string; status: number; body: unknown; headers?: Record<string, string> }> = [];
  try {
    calls.push(await call(base, "reject_missing_authorization", "POST", "/v1/jobs", {
      contract_version: "vfdiag.website-diagnosis.v1",
      url: "https://factory.example/",
      language: "zh",
      idempotency_key: "receipt-auth-01",
      authorization: { version: AUTHORIZATION_VERSION, accepted: false, accepted_at: "2026-11-23T02:00:00.000Z", text_hash: authorizationTextHash() },
    }));
    const createdPrivate = await call(base, "create_private_target", "POST", "/v1/jobs", payload("https://127.0.0.1/", "receipt-private-01"));
    calls.push(createdPrivate);
    const privateRef = (createdPrivate.body as { job_ref: string }).job_ref;
    calls.push(await waitCall(base, "private_target_final", privateRef, "failed"));
    const created = await call(base, "create_report", "POST", "/v1/jobs", payload("https://factory.example/products", "receipt-report-01"));
    calls.push(created);
    const jobRef = (created.body as { job_ref: string }).job_ref;
    calls.push(await waitCall(base, "report_job_status", jobRef, "complete"));
    calls.push(await call(base, "read_report", "GET", `/v1/jobs/${jobRef}/report`));
    calls.push(await call(base, "download_html", "GET", `/v1/jobs/${jobRef}/artifacts/html`));
    calls.push(await call(base, "download_json", "GET", `/v1/jobs/${jobRef}/artifacts/json`));
    const slow = await call(base, "create_cancel", "POST", "/v1/jobs", payload("https://factory.example/slow", "receipt-cancel-01"));
    calls.push(slow);
    const slowRef = (slow.body as { job_ref: string }).job_ref;
    calls.push(await call(base, "cancel_job", "POST", `/v1/jobs/${slowRef}/cancel`));
    calls.push(await call(base, "report_after_cancel", "GET", `/v1/jobs/${slowRef}/report`));
    clock += 8 * 24 * 60 * 60 * 1000;
    calls.push(await call(base, "expired_status", "GET", `/v1/jobs/${jobRef}`));
    calls.push(await call(base, "expired_html", "GET", `/v1/jobs/${jobRef}/artifacts/html`));
    return redact({
      authorization: {
        version: AUTHORIZATION_VERSION,
        statement: AUTHORIZATION_STATEMENT,
        text_hash: authorizationTextHash(),
        covers: "公开页面扫描",
      },
      model_authorization: {
        version: MODEL_AUTHORIZATION_VERSION,
        statement: MODEL_AUTHORIZATION_STATEMENT,
        text_hash: modelAuthorizationTextHash(),
        covers: "公开页面扫描和 Qwen4-Max 处理",
      },
      error_shape: "error.code",
      remaining_unknown: true,
      distinctions: {
        job_ref: "访问引用。服务凭证放在 Authorization 头里，不放进报告或分享文案。",
        job_state: "complete 表示扫描进程退出码为 0 且报告已写入。",
        headline_status: "报告 headline.status 为 partial 表示产品、联系或已证实 404 仍使这次观察不完整。两者不是同一个字段。",
      },
      ssrf_not_proven: [
        "拒绝 127.0.0.1、CGNAT 和 DNS 混合答案，只说明扫描前的目标门禁。",
        "结果里出现目标域名以外的 http(s) 地址时不发布报告，但已经发出的请求收不回来。",
        "容器没有出口防火墙。--resolve 和允许域名不能单独证明跳转或子资源没有访问内网。",
      ],
      calls,
    }, [privateRef, jobRef, slowRef]);
  } finally {
    releaseSlow();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await rm(dir, { recursive: true, force: true });
  }
}

function redact(receipt: Record<string, unknown>, refs: string[]) {
  const labels = ["JOB_PRIVATE", "JOB_REPORT", "JOB_CANCEL"];
  let text = JSON.stringify(receipt);
  refs.forEach((ref, index) => {
    text = text.split(ref).join(labels[index] ?? `JOB_${index}`);
  });
  return JSON.parse(text) as Record<string, unknown>;
}

async function waitCall(base: string, name: string, jobRef: string, state: string) {
  const deadline = Date.now() + 3000;
  let last: Awaited<ReturnType<typeof call>> | undefined;
  while (Date.now() < deadline) {
    last = await call(base, name, "GET", `/v1/jobs/${jobRef}`);
    if ((last.body as { state?: string }).state === state) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out for ${state}: ${JSON.stringify(last?.body)}`);
}

async function call(base: string, name: string, method: string, path: string, jsonBody?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(jsonBody ? { "content-type": "application/json" } : {}),
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
  const type = response.headers.get("content-type") ?? "";
  const headers: Record<string, string> = {};
  for (const key of ["content-type", "content-disposition", "cache-control", "x-content-type-options"]) {
    const value = response.headers.get(key);
    if (value) headers[key] = value;
  }
  if (type.includes("application/json")) {
    return { name, method, path: path.replace(/\/v1\/jobs\/[^/]+/g, "/v1/jobs/JOB"), status: response.status, body: await response.json(), headers };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    name,
    method,
    path: path.replace(/\/v1\/jobs\/[^/]+/g, "/v1/jobs/JOB"),
    status: response.status,
    headers,
    body: {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: bytes.byteLength <= 4096 ? bytes.toString("utf8") : null,
    },
  };
}

function payload(url: string, key: string) {
  return {
    contract_version: "vfdiag.website-diagnosis.v1",
    url,
    language: "zh",
    idempotency_key: key,
    authorization: {
      version: AUTHORIZATION_VERSION,
      accepted: true,
      accepted_at: "2026-11-23T02:00:00.000Z",
      text_hash: authorizationTextHash(),
    },
  };
}

function cancelledCrawl(): CrawlResult {
  return {
    exitCode: null,
    timedOut: false,
    cancelled: true,
    jsonText: null,
    html: null,
    errorCode: "CANCELLED",
    errorMessage: "扫描已取消。",
  };
}

async function writeCrawl(options: { htmlFile: string; jsonFile: string }): Promise<CrawlResult> {
  const jsonText = JSON.stringify({
    crawler: { version: "2.5.1", executedAt: "2026-11-23 02:00:00" },
    stats: { totalUrls: 3 },
    results: [
      { url: "https://factory.example/", status: "200", type: 1 },
      { url: "https://factory.example/products/valve", status: "404", type: 1 },
      { url: "https://factory.example/contact", status: "200", type: 1 },
    ],
    tables: {
      "404": { rows: [{ url: "https://factory.example/products/valve", sourceUqId: "/", statusCode: "404" }] },
      seo: { rows: [{ urlPathAndQuery: "/contact", title: "联系", h1: "联系", description: "" }] },
    },
  });
  await writeFile(options.htmlFile, "<html>synthetic</html>");
  await writeFile(options.jsonFile, jsonText);
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    jsonText,
    html: Buffer.from("<html>synthetic</html>"),
    errorCode: null,
    errorMessage: null,
  };
}
