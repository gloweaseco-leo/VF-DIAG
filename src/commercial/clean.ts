import type { SiteOneJson } from "../report/types.ts";
import { deriveScoreScale } from "./score-scale.ts";

const HTML_TABLES = [
  "visited-urls",
  "seo",
  "seo-headings",
  "non-unique-descriptions",
  "non-unique-titles",
  "security",
  "security-headers",
  "accessibility",
  "non-clickable-phone-numbers",
  "missing-form-labels",
  "missing-image-alt-attributes",
  "404",
  "redirects",
  "skipped-summary",
  "external-urls",
  "ssl-tls-info",
];

const JSON_NOTE =
  "下面是本次扫描实际写下的 JSON。没有出现的表表示这次没有这张表，不能把它当成通过，也不能把它当成缺失。";

const EMPTY_TABLE_NOTE = /No rows found, please edit your search term\.?/gi;

export function cleanSiteOne(siteone: SiteOneJson, html: string | null): string {
  const htmlMode = Boolean(html && hasVerifiedTables(html));
  const body = htmlMode && html ? cleanHtmlReport(html) : cleanJsonReport(siteone);
  const parts = [body];
  if (htmlMode && html) {
    const scores = formatQualityScores(siteone.qualityScores);
    if (scores) parts.push(`SOURCE siteone.json\n${scores}`);
    const complement = jsonComplement(siteone, html);
    if (complement) parts.push(complement);
  }
  if (!html) return parts.join("\n");
  const scale = deriveScoreScale(html);
  parts.push(`SCORE_SCALE ${scale.status} ${scale.max_score ?? "null"}\n${scale.reason}`);
  return parts.join("\n");
}

export function cleanHtmlReport(html: string): string {
  const lines: string[] = ["SITEONE_HTML_CLEAN_START"];
  const title = textContent(matchTag(html, "title") ?? "").slice(0, 300);
  if (title) lines.push(`ORIGINAL REPORT ${title}`);
  for (const label of HTML_TABLES) {
    const table = findTable(html, label);
    if (!table) continue;
    const records = tableRows(table);
    lines.push("SOURCE siteone.html");
    lines.push(`TABLE ${label} rows=${records.length}`);
    for (const record of records) lines.push(JSON.stringify(record));
  }
  const crawler = blockText(findClassBlock(html, "content_crawler_info") ?? "");
  if (crawler) lines.push(`SOURCE siteone.html\nCRAWLER INFO: ${crawler.slice(0, 5000)}`);
  const ssl = blockText(findClassBlock(html, "content_dns_and_ssl") ?? "");
  if (ssl) lines.push(`SOURCE siteone.html\nSSL TLS INFO: ${ssl.slice(0, 3500)}`);
  lines.push("SITEONE_HTML_CLEAN_END");
  return lines.join("\n");
}

const JSON_COMPLEMENT = ["certificate-info", ...HTML_TABLES];

export function htmlSourceMarkers(html: string | null): string[] {
  if (!html || !hasVerifiedTables(html)) return [];
  const markers: string[] = [];
  if (findClassBlock(html, "content_crawler_info")) markers.push("CRAWLER INFO");
  if (findClassBlock(html, "content_dns_and_ssl")) markers.push("SSL TLS INFO");
  return markers;
}

export function htmlExclusiveTables(html: string | null, jsonTableNames: Iterable<string>): string[] {
  if (!html) return [];
  const present = new Set(jsonTableNames);
  return HTML_TABLES.filter((label) => Boolean(findTable(html, label)) && !present.has(label));
}

function jsonComplement(siteone: SiteOneJson, html: string): string {
  const lines: string[] = [];
  for (const name of JSON_COMPLEMENT) {
    if (findTable(html, name)) continue;
    const rows = siteone.tables?.[name]?.rows ?? [];
    if (rows.length === 0) continue;
    lines.push("SOURCE siteone.json");
    lines.push(`TABLE ${name} rows=${rows.length}`);
    for (const row of rows) lines.push(JSON.stringify(row));
  }
  return lines.join("\n");
}

function hasVerifiedTables(html: string): boolean {
  return HTML_TABLES.some((label) => findTable(html, label));
}

function cleanJsonReport(siteone: SiteOneJson): string {
  const lines: string[] = [
    "SITEONE_JSON_START",
    JSON_NOTE,
    `crawler: ${JSON.stringify(siteone.crawler ?? null)}`,
    `options: ${JSON.stringify(siteone.options ?? null)}`,
    `stats: ${JSON.stringify(siteone.stats ?? null)}`,
    "results:",
  ];
  for (const row of siteone.results ?? []) lines.push(JSON.stringify(row));
  const tables = siteone.tables ?? {};
  const names = Object.keys(tables).sort();
  lines.push(`tables: ${names.join(", ") || "(none)"}`);
  for (const name of names) {
    lines.push("SOURCE siteone.json");
    lines.push(`TABLE ${name}`);
    const rows = tables[name]?.rows ?? [];
    if (rows.length === 0) lines.push("(empty)");
    for (const row of rows) lines.push(JSON.stringify(row));
  }
  if (siteone.qualityScores !== undefined) {
    lines.push("qualityScores:");
    lines.push(JSON.stringify(siteone.qualityScores));
  }
  lines.push("SITEONE_JSON_END");
  return lines.join("\n");
}

function findTable(html: string, label: string): string | null {
  const pattern = new RegExp(`<table\\b[^>]*\\bclass\\s*=\\s*(['"])(?:(?!\\1).)*\\b${label}\\b(?:(?!\\1).)*\\1[^>]*>`, "i");
  const found = pattern.exec(html);
  if (!found || found.index === undefined) return null;
  return elementAt(html, found.index, "table");
}

function findClassBlock(html: string, className: string): string | null {
  const pattern = new RegExp(`<div\\b[^>]*\\bclass\\s*=\\s*(['"])(?:(?!\\1).)*\\b${className}\\b(?:(?!\\1).)*\\1[^>]*>`, "i");
  const found = pattern.exec(html);
  if (!found || found.index === undefined) return null;
  return elementAt(html, found.index, "div");
}

function matchTag(html: string, tag: string): string | null {
  const found = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(html);
  if (!found || found.index === undefined) return null;
  return elementAt(html, found.index, tag);
}

function elementAt(html: string, start: number, tag: string): string | null {
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tags.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  return null;
}

function tableRows(table: string): Array<Record<string, string>> {
  const head = table.match(/<thead\b[^>]*>[\s\S]*?<\/thead>/i)?.[0] ?? "";
  const headers = [...head.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/gi)].map((item) => headerLabel(item[0]));
  const body = table.match(/<tbody\b[^>]*>[\s\S]*?<\/tbody>/i)?.[0] ?? table;
  const rows: Array<Record<string, string>> = [];
  for (const tr of body.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const cells = [...tr[0].matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/gi)].map((item) => cellValue(item[0]));
    if (cells.length === 0 || cells.length !== headers.length) continue;
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? "";
    });
    rows.push(record);
  }
  return rows;
}

function headerLabel(th: string): string {
  const label = th.match(/\bdata-label\s*=\s*(['"])(.*?)\1/i)?.[2];
  const text = label && label.trim() ? label : textContent(th);
  return text.replace(/[🔽🔼▼▲].*$/, "").trim();
}

function cellValue(td: string): string {
  const data = td.match(/\bdata-value\s*=\s*(['"])([\s\S]*?)\1/i)?.[2];
  if (data !== undefined && data !== "" && data !== "complex-data") return decode(data);
  return textContent(td);
}

export function formatQualityScores(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { overall?: { name?: unknown; score?: unknown }; categories?: unknown };
  const overall = record.overall?.score;
  if (typeof overall !== "number" || !Number.isFinite(overall)) return null;
  const lines = ["ENGINE_QUALITY_SCORES", `overall ${textOr(record.overall?.name, "Overall")} ${overall}`];
  if (Array.isArray(record.categories)) {
    for (const item of record.categories) {
      if (!item || typeof item !== "object") continue;
      const category = item as { code?: unknown; name?: unknown; score?: unknown; deductions?: unknown };
      if (typeof category.score !== "number") continue;
      lines.push(`${textOr(category.code, "category")} ${textOr(category.name, "score")} ${category.score}`);
      if (!Array.isArray(category.deductions)) continue;
      for (const deduction of category.deductions) {
        if (!deduction || typeof deduction !== "object") continue;
        const entry = deduction as { points?: unknown; reason?: unknown };
        if (typeof entry.reason !== "string" || !entry.reason.trim()) continue;
        lines.push(`deduction ${textOr(category.code, "category")} ${entry.points ?? ""} ${entry.reason.trim()}`);
      }
    }
  }
  return lines.join("\n");
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function blockText(html: string): string {
  const withoutFoot = html.replace(/<tfoot\b[\s\S]*?<\/tfoot>/gi, " ");
  return textContent(withoutFoot).replace(EMPTY_TABLE_NOTE, "").replace(/\s+/g, " ").trim();
}

function textContent(html: string): string {
  return decode(html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
