import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const placeholder = "local-docker-dev-token-change-me";
const envPath = new URL("../.env", import.meta.url);

let current = "";
try {
  current = await readFile(envPath, "utf8");
} catch {
  current = "";
}
const existing = current.match(/^VFDIAG_SERVICE_TOKEN=(.*)$/m)?.[1]?.trim() ?? "";
const strong = existing.length >= 32 && new Set(existing).size >= 8 && existing !== placeholder;
if (strong && !process.argv.includes("--rotate")) {
  console.log(".env already has an independent funnel token. The value was not printed.");
  console.log("Set that same value as VFDIAG_SERVICE_TOKEN on the Vercel Preview project.");
  process.exit(0);
}

const token = randomBytes(32).toString("base64url");
const body = [
  "# Independent VF-DIAG funnel credential. Not a VRAE key. Do not commit this file.",
  `VFDIAG_SERVICE_TOKEN=${token}`,
  "VFDIAG_LOCAL_ONLY=1",
  "VFDIAG_FUNNEL=1",
  "",
].join("\n");
await writeFile(envPath, body, { mode: 0o600 });
console.log("Wrote .env. The token was not printed.");
console.log("Set the same value as VFDIAG_SERVICE_TOKEN on the Vercel Preview project. Do not paste it into chat, git, or the PR.");
