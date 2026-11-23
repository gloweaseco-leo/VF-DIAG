export function redactSecrets(text: string, secrets: string[]): string {
  let out = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.replaceAll(secret, "[redacted]");
  }
  return out;
}

export function accessLog(method: string | undefined, rawPath: string, status: number, secret: string): string {
  let path = rawPath.split("?")[0] || "/";
  path = redactSecrets(path, [secret]);
  return JSON.stringify({ method: method ?? "", path, status });
}
