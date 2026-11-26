import type { SiteOneJson } from "../report/types.ts";
import { deriveScoreScale } from "./score-scale.ts";

const TABLE_NOTE =
  "下面是本次扫描实际写下的 JSON。没有出现的表表示这次没有这张表，不能把它当成通过，也不能把它当成缺失。";

export function cleanSiteOne(siteone: SiteOneJson, html: string | null): string {
  const lines: string[] = [
    "SITEONE_JSON_START",
    TABLE_NOTE,
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
  if (html) {
    const scale = deriveScoreScale(html);
    lines.push(`SCORE_SCALE ${scale.status} ${scale.max_score ?? "null"}`);
    lines.push(scale.reason);
  }
  return lines.join("\n");
}
