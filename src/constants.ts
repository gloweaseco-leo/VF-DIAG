export const CONTRACT_VERSION = "vfdiag.website-diagnosis.v1" as const;
export const REPORT_SCHEMA_VERSION = "1.0" as const;
export const ENGINE = "siteone" as const;
export const ENGINE_VERSION = "2.5.1" as const;
export const REPORT_LANGUAGE = "zh" as const;
export const REPORT_TIMEZONE = "Asia/Shanghai" as const;
export const RETENTION_DAYS = 7;
export const MAX_URLS = 50;
export const MAX_DEPTH = 3;
export const MAX_REQS_PER_SEC = 1;
export const WORKERS = 1;
export const REQUEST_TIMEOUT_SECONDS = 20;
export const WALL_CLOCK_MS = 180_000;
export const MEMORY_LIMIT = "512M";
export const AUTHORIZATION_VERSION = "2026-11-22";
export const AUTHORIZATION_STATEMENT =
  "我确认对该网站拥有管理权限，或已获得网站管理者授权进行公开页面诊断。";
export const MODEL_AUTHORIZATION_VERSION = "2026-11-26-growth-candidate";
export const MODEL_AUTHORIZATION_STATEMENT =
  "我确认对该网站拥有管理权限，或已获得网站管理者授权进行公开页面诊断；同意将本次获准公开页面的检测报告及必要摘录提交阿里云百炼 Qwen4-Max 模型处理，用于生成海外获客诊断报告。";
export const USER_AGENT =
  "VEYFRONT-VFDIAG/0.1 (authorized site diagnosis; +https://veyfront.com/contact)";

export const SITEONE_TARBALL_SHA256 =
  "bd96b9502563aea2581fc248625871e69b60d7f1bb68a484f226c551c73706fd";
export const SITEONE_BINARY_SHA256 =
  "4b0b40d99ec3911f330222c666018dc2bb29bea7368fd7100e2cd9f56ab8e15b";

export const AI_VISIBILITY_STATEMENT = "本次未检测 AI 是否引用该网站。";
export const SCAN_SCOPE =
  "SiteOne v2.5.1，最多 50 个 URL，深度不超过 3，每秒最多 1 个请求，未启用浏览器渲染。";
