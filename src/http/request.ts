import { createHash } from "node:crypto";
import { AUTHORIZATION_STATEMENT, AUTHORIZATION_VERSION, MODEL_AUTHORIZATION_STATEMENT, MODEL_AUTHORIZATION_VERSION } from "../constants.ts";

export function authorizationTextHash(): string {
  return createHash("sha256").update(AUTHORIZATION_STATEMENT, "utf8").digest("hex");
}

export function modelAuthorizationTextHash(): string {
  return createHash("sha256").update(MODEL_AUTHORIZATION_STATEMENT, "utf8").digest("hex");
}

export const LOCAL_DEV_TOKEN = "local-docker-dev-token-change-me";

export function assertServiceToken(token: string | undefined, options?: { localOnly?: boolean; funnel?: boolean }): string {
  if (!token || token.trim().length < 16) {
    throw new Error("VFDIAG_SERVICE_TOKEN 至少需要 16 个字符。");
  }
  const value = token.trim();
  if (options?.funnel === true) {
    if (value === LOCAL_DEV_TOKEN || value.length < 32 || new Set(value).size < 8) {
      throw new Error("Funnel 入口必须使用至少 32 位、不可预测的独立服务凭据，不能使用本地占位口令。");
    }
    return value;
  }
  if (value === LOCAL_DEV_TOKEN && options?.localOnly !== true) {
    throw new Error("默认本地口令只能在 VFDIAG_LOCAL_ONLY=1 时使用。远程暴露前必须换成随机凭据。");
  }
  return value;
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
  model_authorized: boolean;
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
  const modelAuthorized = auth.version === MODEL_AUTHORIZATION_VERSION && auth.text_hash === modelAuthorizationTextHash();
  const scanAuthorized = auth.version === AUTHORIZATION_VERSION && auth.text_hash === authorizationTextHash();
  if (!modelAuthorized && !scanAuthorized) {
    return { ok: false, code: "AUTHORIZATION_TEXT_MISMATCH", message: "授权声明版本或文本与服务器记录不一致。" };
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
      model_authorized: modelAuthorized,
      authorization: {
        version: modelAuthorized ? MODEL_AUTHORIZATION_VERSION : AUTHORIZATION_VERSION,
        accepted: true,
        accepted_at: new Date(auth.accepted_at).toISOString(),
        text_hash: modelAuthorized ? modelAuthorizationTextHash() : authorizationTextHash(),
      },
    },
  };
}
