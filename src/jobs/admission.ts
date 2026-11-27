import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  BROWSER_DAILY_SITES,
  DAILY_MODEL_BUDGET_HARD_FEN,
  DAILY_MODEL_BUDGET_SOFT_FEN,
  IP_DAILY_TASKS,
  REPORT_TIMEZONE,
  SITE_SUCCESS_WINDOW_MS,
} from "../constants.ts";

export type AdmissionIdentity = { browser: string; ip: string };

export type SiteRecord = {
  success_at: string | null;
  active_job: string | null;
  model_job: string | null;
  model_at: string | null;
};

export type DayRecord = {
  browsers: Record<string, string>;
  ips: Record<string, number>;
  spend_fen: number;
  warned: boolean;
  charged_jobs: string[];
};

export type Ledger = {
  sites: Record<string, SiteRecord>;
  days: Record<string, DayRecord>;
};

export type AdmissionRefusal = { ok: false; status: number; code: string; message: string };

const HEX = /^[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function canonicalHost(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  let host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return host || null;
}

export function rawHost(input: string): string | null {
  try {
    const host = new URL(input.trim()).hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
    return host || null;
  } catch {
    return null;
  }
}

export function shanghaiDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function readAdmissionHeaders(
  headers: { get(name: string): string | null },
  now: Date,
): { ok: true; value: AdmissionIdentity | null } | AdmissionRefusal {
  const day = headers.get("x-vf-admission-day");
  const browser = headers.get("x-vf-admission-browser");
  const ip = headers.get("x-vf-admission-ip");
  if (day === null && browser === null && ip === null) return { ok: true, value: null };
  if (!day || !DAY.test(day) || day !== shanghaiDay(now)) {
    return { ok: false, status: 400, code: "ADMISSION_REQUIRED", message: "付费诊断需要与上海日期一致的当日准入日期。" };
  }
  if (!browser || !HEX.test(browser) || !ip || !HEX.test(ip)) {
    return { ok: false, status: 400, code: "ADMISSION_REQUIRED", message: "付费诊断需要当日的浏览器和网络标识。" };
  }
  return { ok: true, value: { browser, ip } };
}

export function emptyLedger(): Ledger {
  return { sites: {}, days: {} };
}

export function decideAdmission(
  ledger: Ledger,
  input: { now: Date; host: string; browser: string; ip: string },
): { ok: true } | AdmissionRefusal {
  const site = ledger.sites[input.host];
  if (site?.active_job) {
    return { ok: false, status: 409, code: "SITE_DIAGNOSIS_IN_PROGRESS", message: "这个网站正在诊断，不能重复创建任务。" };
  }
  if (site?.success_at && input.now.getTime() - Date.parse(site.success_at) < SITE_SUCCESS_WINDOW_MS) {
    return { ok: false, status: 409, code: "SITE_RECENTLY_DIAGNOSED", message: "这个网站 7 天内已经完成过一次诊断。" };
  }
  const day = dayRecord(ledger, shanghaiDay(input.now));
  const seen = day.browsers[input.browser];
  if (BROWSER_DAILY_SITES <= 1 && seen && seen !== input.host) {
    return { ok: false, status: 429, code: "BROWSER_DAILY_LIMIT", message: "当前浏览器今天只能诊断一个新网站。" };
  }
  if ((day.ips[input.ip] ?? 0) >= IP_DAILY_TASKS) {
    return { ok: false, status: 429, code: "IP_DAILY_LIMIT", message: "当前网络今天的新诊断任务已达上限。" };
  }
  if (day.spend_fen >= DAILY_MODEL_BUDGET_HARD_FEN) {
    return { ok: false, status: 429, code: "DAILY_BUDGET_LIMIT", message: "今日模型费用已达上限，暂停接受新的付费诊断。" };
  }
  return { ok: true };
}

export function reserveAdmission(
  ledger: Ledger,
  input: { now: Date; host: string; browser: string; ip: string; jobRef: string },
): Ledger {
  const next = structuredClone(ledger);
  const site = siteRecord(next, input.host);
  site.active_job = input.jobRef;
  const day = dayRecord(next, shanghaiDay(input.now));
  if (!day.browsers[input.browser]) day.browsers[input.browser] = input.host;
  day.ips[input.ip] = (day.ips[input.ip] ?? 0) + 1;
  return prune(next, input.now);
}

export function syncAdmission(
  ledger: Ledger,
  input: {
    now: Date;
    host: string;
    jobRef: string;
    active: boolean;
    success: boolean;
    requestSent: boolean;
    costCny: number | null;
  },
): { ledger: Ledger; warn: string | null } {
  const next = structuredClone(ledger);
  const site = siteRecord(next, input.host);
  if (input.active) site.active_job = input.jobRef;
  else if (site.active_job === input.jobRef) site.active_job = null;
  if (input.success && !site.success_at) site.success_at = input.now.toISOString();
  if (input.requestSent && !site.model_job) {
    site.model_job = input.jobRef;
    site.model_at = input.now.toISOString();
  }
  let warn: string | null = null;
  if (typeof input.costCny === "number" && Number.isFinite(input.costCny) && input.costCny > 0) {
    const key = shanghaiDay(input.now);
    const day = dayRecord(next, key);
    if (!day.charged_jobs.includes(input.jobRef)) {
      day.charged_jobs.push(input.jobRef);
      day.spend_fen += Math.round(input.costCny * 100);
      if (day.spend_fen >= DAILY_MODEL_BUDGET_SOFT_FEN && !day.warned) {
        day.warned = true;
        warn = `budget soft_limit day=${key} spend_fen=${day.spend_fen}`;
      }
    }
  }
  return { ledger: prune(next, input.now), warn };
}

export async function loadLedger(file: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Ledger>;
    return {
      sites: parsed.sites && typeof parsed.sites === "object" ? parsed.sites : {},
      days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
    };
  } catch {
    return emptyLedger();
  }
}

export async function saveLedger(file: string, ledger: Ledger): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `admission.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, JSON.stringify(ledger));
  try {
    await rename(temp, file);
    return;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EPERM" && code !== "EBUSY" && code !== "EEXIST") {
      await rm(temp, { force: true });
      throw error;
    }
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await copyFile(temp, file);
      await rm(temp, { force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EPERM" && code !== "EBUSY") break;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  await rm(temp, { force: true });
  throw lastError;
}

function siteRecord(ledger: Ledger, host: string): SiteRecord {
  const current = ledger.sites[host] ?? { success_at: null, active_job: null, model_job: null, model_at: null };
  ledger.sites[host] = current;
  return current;
}

function dayRecord(ledger: Ledger, day: string): DayRecord {
  const current = ledger.days[day] ?? { browsers: {}, ips: {}, spend_fen: 0, warned: false, charged_jobs: [] };
  ledger.days[day] = current;
  return current;
}

function prune(ledger: Ledger, now: Date): Ledger {
  const today = shanghaiDay(now);
  for (const day of Object.keys(ledger.days)) {
    if (day < shiftDay(today, -2)) delete ledger.days[day];
  }
  for (const [host, site] of Object.entries(ledger.sites)) {
    const successFresh = fresh(site.success_at, now);
    const modelFresh = fresh(site.model_at, now);
    if (!site.active_job && !successFresh && !modelFresh) delete ledger.sites[host];
  }
  return ledger;
}

function fresh(value: string | null, now: Date): boolean {
  return value !== null && now.getTime() - Date.parse(value) < SITE_SUCCESS_WINDOW_MS;
}

function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}
