import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { accessLog, redactSecrets } from "./redact.ts";
import { parseCreateJob } from "./request.ts";
import type { JobService } from "../jobs/service.ts";

export function createHttpServer(options: { token: string; jobs: JobService; ratePerMinute?: number }) {
  const hits = new Map<string, number[]>();
  return createServer((req, res) => {
    void handle(req, res, options, hits).catch((error: unknown) => {
      const raw = error instanceof Error ? error.message : "error";
      console.log(redactSecrets(raw, [options.token]));
      if (!res.headersSent) {
        console.log(accessLog(req.method, req.url ?? "/", 500, options.token));
        sendJson(res, 500, { error: { code: "ENGINE_FAILED", message: "服务器内部错误。" } });
      }
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: { token: string; jobs: JobService; ratePerMinute?: number },
  hits: Map<string, number[]>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://worker.local");
  const path = url.pathname;
  const respond = (status: number, body: unknown) => {
    console.log(accessLog(req.method, path, status, options.token));
    sendJson(res, status, body);
  };
  if (tooMany(req, hits, options.ratePerMinute ?? 0)) {
    respond(429, { error: { code: "RATE_LIMIT", message: "请求过于频繁。" } });
    return;
  }
  if (req.method === "GET" && path === "/v1/health") {
    respond(200, {
      status: "ok",
      contract_version: "vfdiag.website-diagnosis.v1",
      engine: "siteone",
      engine_version: "2.5.1",
      report_language: "zh",
      retention_days: 7,
    });
    return;
  }
  if (!authorized(req, options.token)) {
    respond(401, { error: { code: "UNAUTHORIZED", message: "服务凭证无效。" } });
    return;
  }

  const jobMatch = path.match(/^\/v1\/jobs\/([A-Za-z0-9_-]{8,80})(\/report|\/cancel|\/artifacts\/(html|json))?$/);
  if (req.method === "POST" && path === "/v1/jobs") {
    const parsed = parseCreateJob(await readJson(req));
    if (!parsed.ok) {
      respond(400, { error: { code: parsed.code, message: parsed.message } });
      return;
    }
    const created = await options.jobs.create(parsed.value);
    respond(created.status, created.body);
    return;
  }
  if (!jobMatch) {
    respond(404, { error: { code: "JOB_NOT_FOUND", message: "路径不存在。" } });
    return;
  }
  const jobRef = jobMatch[1];
  const suffix = jobMatch[2] ?? "";
  if (req.method === "GET" && suffix === "") {
    const result = await options.jobs.get(jobRef);
    respond(result.status, result.body);
    return;
  }
  if (req.method === "POST" && suffix === "/cancel") {
    const result = await options.jobs.cancel(jobRef);
    respond(result.status, result.body);
    return;
  }
  if (req.method === "GET" && suffix === "/report") {
    const result = await options.jobs.report(jobRef);
    respond(result.status, result.body);
    return;
  }
  const artifact = suffix.match(/^\/artifacts\/(html|json)$/);
  if (req.method === "GET" && artifact) {
    const result = await options.jobs.artifact(jobRef, artifact[1]);
    if ("contentType" in result) {
      res.writeHead(200, {
        "content-type": result.contentType,
        "content-disposition": `attachment; filename="${result.filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      console.log(accessLog(req.method, path, 200, options.token));
      res.end(result.body);
      return;
    }
    respond(result.status, result.body);
    return;
  }
  respond(404, { error: { code: "JOB_NOT_FOUND", message: "路径不存在。" } });
}

function tooMany(req: IncomingMessage, hits: Map<string, number[]>, limit: number): boolean {
  if (limit <= 0) return false;
  const forwarded = req.headers["x-forwarded-for"];
  const key = typeof forwarded === "string" && forwarded.trim() ? forwarded.split(",")[0].trim() : "local";
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) throw new Error("body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
}
