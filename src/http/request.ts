import { createHash } from "node:crypto";
import { AUTHORIZATION_STATEMENT, AUTHORIZATION_VERSION } from "../constants.ts";

export function authorizationTextHash(): string {
  return createHash("sha256").update(AUTHORIZATION_STATEMENT, "utf8").digest("hex");
}

export function assertServiceToken(token: string | undefined): string {
  if (!token || token.trim().length < 16) {
    throw new Error("VFDIAG_SERVICE_TOKEN 至少需要 16 个字符。");
  }
  return token.trim();
}

export type CreateJobBody = {
  contract_version: string;
  url: string;
  language: "zh" | "en";
  authorization: {
    version: string;
    accepted: boolean;
    accepted_at: string;
    text_hash: string;
  };
  idempotency_key: string;
};

export function parseCreateJob(body: unknown): { ok: true; value: CreateJobBody } | { ok: false; code: string; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, code: "TARGET_URL_INVALID", message: "请求体必须是 JSON 对象。" };
  }
  const record = body as Record<string, unknown>;
  if (record.contract_version !== "vfdiag.website-diagnosis.v1") {
    return { ok: false, code: "CONTRACT_MISMATCH", message: "contract_version 必须是 vfdiag.website-diagnosis.v1。" };
  }
  if (typeof record.url !== "string" || record.url.length === 0 || record.url.length > 2000) {
    return { ok: false, code: "TARGET_URL_INVALID", message: "url 必须是不超过 2000 字符的字符串。" };
  }
  if (record.language !== "zh" && record.language !== "en") {
    return { ok: false, code: "LANGUAGE_UNSUPPORTED", message: "language 只能是 zh 或 en。报告正文目前只生成中文。" };
  }
  if (typeof record.idempotency_key !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(record.idempotency_key)) {
    return { ok: false, code: "IDEMPOTENCY_CONFLICT", message: "idempotency_key 需要 8 到 80 位字母、数字、下划线或短横线。" };
  }
  const authorization = record.authorization;
  if (!authorization || typeof authorization !== "object") {
    return { ok: false, code: "AUTHORIZATION_REQUIRED", message: "缺少授权声明。" };
  }
  const auth = authorization as Record<string, unknown>;
  if (auth.accepted !== true) {
    return { ok: false, code: "AUTHORIZATION_REQUIRED", message: "必须明确勾选授权声明后才能扫描。" };
  }
  if (auth.version !== AUTHORIZATION_VERSION) {
    return { ok: false, code: "AUTHORIZATION_TEXT_MISMATCH", message: "授权声明版本不是当前版本。" };
  }
  if (auth.text_hash !== authorizationTextHash()) {
    return { ok: false, code: "AUTHORIZATION_TEXT_MISMATCH", message: "授权声明文本与服务器记录不一致。" };
  }
  if (typeof auth.accepted_at !== "string" || Number.isNaN(Date.parse(auth.accepted_at))) {
    return { ok: false, code: "AUTHORIZATION_REQUIRED", message: "accepted_at 必须是可解析的时间。" };
  }
  return {
    ok: true,
    value: {
      contract_version: "vfdiag.website-diagnosis.v1",
      url: record.url,
      language: record.language,
      idempotency_key: record.idempotency_key,
      authorization: {
        version: AUTHORIZATION_VERSION,
        accepted: true,
        accepted_at: new Date(auth.accepted_at).toISOString(),
        text_hash: authorizationTextHash(),
      },
    },
  };
}
