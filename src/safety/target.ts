import { isIP } from "node:net";
import { isBlockedIp, isRfc1918 } from "./ip.ts";

export type Lookup = (hostname: string) => Promise<string[]>;

export type ResolvedTarget = {
  href: string;
  origin: string;
  host: string;
  port: number;
  addresses: string[];
  synthetic: boolean;
};

export type TargetVerdict =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; code: string; message: string };

const BLOCKED_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.internal",
]);

export async function evaluateTarget(
  input: string,
  options: { lookup: Lookup; syntheticHosts: ReadonlySet<string> },
): Promise<TargetVerdict> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return reject("TARGET_URL_INVALID", "网址无法解析。只接受完整的 http 或 https 网址。");
  }
  if (url.username || url.password) {
    return reject("TARGET_URL_INVALID", "网址里不能带账号或密码。");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host || BLOCKED_NAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    return reject("TARGET_HOST_REJECTED", "这个主机名不在允许扫描的范围内。");
  }
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    return reject("TARGET_HOST_REJECTED", "不接受用数字写成的地址。");
  }

  const synthetic = options.syntheticHosts.has(host);
  if (synthetic) {
    if (url.protocol !== "http:") {
      return reject("TARGET_SCHEME_REJECTED", "合成样本只允许 http。");
    }
    if (url.port !== "" && url.port !== "80" && url.port !== "8080") {
      return reject("TARGET_PORT_REJECTED", "合成样本只允许 80 或 8080 端口。");
    }
  } else {
    if (url.protocol !== "https:") {
      return reject("TARGET_SCHEME_REJECTED", "正式扫描只接受 https。");
    }
    if (url.port !== "" && url.port !== "443") {
      return reject("TARGET_PORT_REJECTED", "正式扫描只接受 443 端口。");
    }
  }

  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      return reject("TARGET_PRIVATE_ADDRESS", "目标地址落在私网、回环或链路本地范围。");
    }
    return reject("TARGET_HOST_REJECTED", "请使用域名，不要直接填写 IP。");
  }
  if (!synthetic && !host.includes(".")) {
    return reject("TARGET_HOST_REJECTED", "正式扫描只接受带点的公网域名。");
  }

  let addresses: string[];
  try {
    addresses = [...new Set(await options.lookup(host))];
  } catch {
    return reject("TARGET_DNS_FAILED", "域名没有解析出可用地址。");
  }
  if (addresses.length === 0) {
    return reject("TARGET_DNS_FAILED", "域名没有解析出可用地址。");
  }

  if (synthetic) {
    if (addresses.some((ip) => !isRfc1918(ip))) {
      return reject(
        "TARGET_PRIVATE_ADDRESS",
        "合成主机只能解析到私网地址。出现公网、回环或链路本地地址时已拒绝。",
      );
    }
  } else if (addresses.some((ip) => isBlockedIp(ip))) {
    return reject("TARGET_PRIVATE_ADDRESS", "域名解析到了私网、回环或链路本地地址。");
  }

  const port = url.port ? Number(url.port) : synthetic ? 80 : 443;
  url.hash = "";
  return {
    ok: true,
    target: {
      href: url.href,
      origin: url.origin,
      host,
      port,
      addresses,
      synthetic,
    },
  };
}

function reject(code: string, message: string): TargetVerdict {
  return { ok: false, code, message };
}
