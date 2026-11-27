import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  BROWSER_DAILY_SITES,
  DAILY_MODEL_BUDGET_FEN,
  IP_DAILY_TASKS,
  MONTHLY_MODEL_BUDGET_FEN,
  REPORT_TIMEZONE,
  SITE_MODEL_BUDGET_FEN,
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
};

export type ChargeRecord = {
  host: string;
  at: string;
  fen: number;
  priced: boolean;
  unresolved: boolean;
  blocks_model: boolean;
  ceiling_fen: number;
};

export type BudgetCaps = {
  siteFen: number;
  dailyFen: number;
  monthlyFen: number;
};

export type Ledger = {
  sites: Record<string, SiteRecord>;
  days: Record<string, DayRecord>;
  charges: Record<string, ChargeRecord>;
};

export const DEFAULT_BUDGET: BudgetCaps = {
  siteFen: SITE_MODEL_BUDGET_FEN,
  dailyFen: DAILY_MODEL_BUDGET_FEN,
  monthlyFen: MONTHLY_MODEL_BUDGET_FEN,
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
  return { sites: {}, days: {}, charges: {} };
}

export function readBudgetCaps(env: Record<string, string | undefined>): BudgetCaps {
  return {
    siteFen: yuanToFen(env.VFDIAG_SITE_MODEL_BUDGET_CNY, 6),
    dailyFen: yuanToFen(env.VFDIAG_DAILY_MODEL_BUDGET_CNY, 30),
    monthlyFen: yuanToFen(env.VFDIAG_MONTHLY_MODEL_BUDGET_CNY, 500),
  };
}

export function decideAdmission(
  ledger: Ledger,
  input: { now: Date; host: string; browser: string; ip: string },
  caps: BudgetCaps = DEFAULT_BUDGET,
  nextFen = 0,
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
  return budgetFit(ledger, { now: input.now, host: input.host }, caps, nextFen);
}

export function budgetFit(
  ledger: Ledger,
  input: { now: Date; host: string },
  caps: BudgetCaps,
  nextFen: number,
): { ok: true } | AdmissionRefusal {
  const exposure = budgetExposure(ledger, input.now, input.host);
  const site = fitCap(exposure.site, caps.siteFen, nextFen, "这个网站的诊断费用已达单站上限，暂停新的付费诊断。", "下一次模型调用的费用上限会超过单站上限，已停止新的付费诊断。");
  if (site) return site;
  const day = fitCap(exposure.day, caps.dailyFen, nextFen, "今日模型费用已达上限，暂停接受新的付费诊断。", "下一次模型调用的费用上限会超过今日预算，已停止新的付费诊断。");
  if (day) return day;
  const month = fitCap(exposure.month, caps.monthlyFen, nextFen, "本月模型费用已达上限，暂停接受新的付费诊断。", "下一次模型调用的费用上限会超过本月预算，已停止新的付费诊断。");
  if (month) return month;
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
    at: string;
    active: boolean;
    success: boolean;
    settled: boolean;
    requestSent: boolean;
    connectionFailure: boolean;
    costCny: number | null;
    ceilingFen?: number | null;
  },
): { ledger: Ledger } {
  const next = structuredClone(ledger);
  if (!next.charges) next.charges = {};
  const site = siteRecord(next, input.host);
  if (input.active) site.active_job = input.jobRef;
  else if (site.active_job === input.jobRef) site.active_job = null;
  if (input.success) {
    const at = input.at;
    if (!site.success_at || Date.parse(at) > Date.parse(site.success_at)) site.success_at = at;
  }
  const charge = classifyCharge(next.charges[input.jobRef], input);
  if (charge) {
    next.charges[input.jobRef] = charge;
    if (charge.blocks_model && (!site.model_at || Date.parse(charge.at) >= Date.parse(site.model_at))) {
      site.model_job = input.jobRef;
      site.model_at = charge.at;
    }
  }
  return { ledger: prune(next, input.now) };
}

export async function loadLedger(file: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Ledger> & { days?: Record<string, DayRecord & { spend_fen?: unknown }> };
    const days: Record<string, DayRecord> = {};
    for (const [key, day] of Object.entries(parsed.days ?? {})) {
      if (!day || typeof day !== "object") continue;
      days[key] = {
        browsers: day.browsers && typeof day.browsers === "object" ? day.browsers : {},
        ips: day.ips && typeof day.ips === "object" ? day.ips : {},
      };
    }
    return {
      sites: parsed.sites && typeof parsed.sites === "object" ? parsed.sites : {},
      days,
      charges: normalizeCharges(parsed.charges),
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
  const current = ledger.days[day] ?? { browsers: {}, ips: {} };
  ledger.days[day] = { browsers: current.browsers ?? {}, ips: current.ips ?? {} };
  return ledger.days[day];
}

function prune(ledger: Ledger, now: Date): Ledger {
  const today = shanghaiDay(now);
  const month = today.slice(0, 7);
  for (const day of Object.keys(ledger.days)) {
    if (day < shiftDay(today, -2)) delete ledger.days[day];
  }
  for (const [jobRef, charge] of Object.entries(ledger.charges ?? {})) {
    const at = new Date(charge.at);
    const chargeDay = shanghaiDay(at);
    const inWindow = now.getTime() - at.getTime() < SITE_SUCCESS_WINDOW_MS;
    if (!inWindow && chargeDay.slice(0, 7) !== month) delete ledger.charges[jobRef];
  }
  for (const [host, site] of Object.entries(ledger.sites)) {
    const successFresh = fresh(site.success_at, now);
    const modelFresh = fresh(site.model_at, now);
    if (!site.active_job && !successFresh && !modelFresh) delete ledger.sites[host];
  }
  return ledger;
}

function classifyCharge(existing: ChargeRecord | undefined, input: {
  at: string;
  settled: boolean;
  requestSent: boolean;
  connectionFailure: boolean;
  costCny: number | null;
  ceilingFen?: number | null;
  host: string;
}): ChargeRecord | null {
  if (!input.requestSent && !existing) return null;
  const at = existing?.at ?? input.at;
  if (!input.requestSent) return existing ?? null;
  const ceiling = input.connectionFailure ? 0 : input.ceilingFen ?? existing?.ceiling_fen ?? 0;
  if (input.connectionFailure) {
    return { host: input.host, at, fen: 0, priced: true, unresolved: false, blocks_model: false, ceiling_fen: 0 };
  }
  if (typeof input.costCny === "number" && Number.isFinite(input.costCny) && input.costCny >= 0) {
    return { host: input.host, at, fen: Math.round(input.costCny * 100), priced: true, unresolved: false, blocks_model: true, ceiling_fen: ceiling };
  }
  if (!input.settled) {
    return { host: input.host, at, fen: 0, priced: false, unresolved: false, blocks_model: false, ceiling_fen: ceiling };
  }
  return { host: input.host, at, fen: 0, priced: false, unresolved: true, blocks_model: true, ceiling_fen: ceiling };
}

function budgetExposure(ledger: Ledger, now: Date, host: string): { site: number; day: number; month: number } {
  let site = 0;
  let day = 0;
  let month = 0;
  const dayKey = shanghaiDay(now);
  const monthKey = dayKey.slice(0, 7);
  for (const charge of Object.values(ledger.charges ?? {})) {
    const at = new Date(charge.at);
    if (Number.isNaN(at.getTime())) continue;
    const amount = charge.priced ? charge.fen : Math.max(0, charge.ceiling_fen ?? 0);
    if (charge.host === host && now.getTime() - at.getTime() < SITE_SUCCESS_WINDOW_MS) site += amount;
    const chargeDay = shanghaiDay(at);
    if (chargeDay === dayKey) day += amount;
    if (chargeDay.slice(0, 7) === monthKey) month += amount;
  }
  return { site, day, month };
}

function fitCap(spent: number, cap: number, nextFen: number, reached: string, ahead: string): AdmissionRefusal | null {
  if (spent >= cap) return { ok: false, status: 429, code: "DAILY_BUDGET_LIMIT", message: reached };
  if (nextFen > 0 && spent + nextFen > cap) return { ok: false, status: 429, code: "DAILY_BUDGET_LIMIT", message: ahead };
  return null;
}

function normalizeCharges(value: unknown): Record<string, ChargeRecord> {
  if (!value || typeof value !== "object") return {};
  const charges: Record<string, ChargeRecord> = {};
  for (const [jobRef, raw] of Object.entries(value as Record<string, ChargeRecord>)) {
    if (!raw || typeof raw !== "object") continue;
    charges[jobRef] = { ...raw, ceiling_fen: typeof raw.ceiling_fen === "number" ? raw.ceiling_fen : 0 };
  }
  return charges;
}

function yuanToFen(raw: string | undefined, fallbackYuan: number): number {
  if (raw === undefined || raw.trim() === "") return Math.round(fallbackYuan * 100);
  const yuan = Number(raw);
  if (!Number.isFinite(yuan) || yuan < 0) return Math.round(fallbackYuan * 100);
  return Math.round(yuan * 100);
}

function fresh(value: string | null, now: Date): boolean {
  return value !== null && now.getTime() - Date.parse(value) < SITE_SUCCESS_WINDOW_MS;
}

function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}
