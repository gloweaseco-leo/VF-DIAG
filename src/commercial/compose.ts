import { createHash } from "node:crypto";
import type { ScoreScale } from "./score-scale.ts";

const VERDICTS = ["targeted_optimization", "further_verification", "site_rebuild_assessment", "no_urgent_action"] as const;
type Verdict = (typeof VERDICTS)[number];

const VERDICT_LABEL: Record<Verdict, string> = {
  targeted_optimization: "建议先做有针对性的局部优化",
  further_verification: "先核实关键事实，再决定投入",
  site_rebuild_assessment: "建议评估一次系统性升级",
  no_urgent_action: "现有网站可以继续使用",
};

const CHAPTERS = [
  { id: "discover", title: "产品被找到、被看懂", areas: ["product_discoverability", "product_understanding"] },
  { id: "convince", title: "信任与已有营销资产", areas: ["trust"] },
  { id: "connect", title: "询盘与联系承接", areas: ["inquiry"] },
] as const;

const TASK_TITLE: Record<string, string> = {
  find_products: "找到产品",
  understand_products: "看懂产品",
  contact_supplier: "联系供应商",
};

export type CommercialReport = {
  contract_version: "vfdiag.commercial-report.v1";
  job_ref: string;
  revision: string;
  synthetic: boolean;
  report_language: "zh";
  generated_at: string;
  subject: {
    domain: string;
    observed_at: string | null;
    checked_urls: number;
    http_200: number;
    http_301: number;
    scope_summary: string;
    limitations: string[];
    data_sufficiency: "adequate_for_limited_report" | "partial" | "unusable";
    limited: boolean;
  };
  delivery: {
    profile: "veyfront.overseas-acquisition.v2.1";
    sections: ["overview", "discover", "convince", "connect", "next", "technical_appendix"];
    pdf: { producer: "VEYFRONT"; status: "PENDING_VEYFRONT_PRINT"; visual_system: "veyfront.report.v2.1" };
  };
  overview: {
    headline: string;
    verdict: Verdict;
    verdict_label: string;
    verdict_reason: string;
    strengths: Array<{ text: string; evidence_ids: string[] }>;
    buyer_tasks: Array<{ task: string; title: string; status: string; fact: string; unknown: string; evidence_ids: string[] }>;
  };
  chapters: Array<{ id: "discover" | "convince" | "connect"; title: string; findings: FindingView[] }>;
  visuals: Array<{
    id: string;
    type: string;
    caption: string;
    disclaimer: string;
    evidence_ids: string[];
    asset_available: boolean;
    sources: EvidenceSource[];
  }>;
  next_step: {
    offer_name: string;
    offer_scope: string;
    cta_label: string;
    cta_request: string;
    unpromised_fields: string[];
    choices: Array<{ id: string; label: string; area: string }>;
  };
  technical_appendix: {
    is_business_score: false;
    score_scale: ScoreScale["status"];
    overall: MetricView | null;
    dimensions: MetricView[];
    notes: Array<{ label: string; fact: string; significance: string }>;
    not_checked: string[];
  };
  evidence: EvidenceView[];
};

type EvidenceSource = {
  evidence_id: string;
  source_file: string;
  source_location: string;
  url: string | null;
  raw_value: string | number | null;
};

type EvidenceView = EvidenceSource & {
  id: string;
  fact: string;
  denominator: number | null;
};

type FindingView = {
  id: string;
  priority: string;
  area: string;
  title: string;
  observed_fact: string;
  possible_effect: string;
  effect_level: string;
  recommended_action: string;
  acceptance_checks: string[];
  needs_confirmation: string[];
  evidence_ids: string[];
};

type MetricView = { label: string; score: number | null; max_score: number | null; caveat: string };

type Analysis = {
  source_profile: {
    target_domain: string;
    observed_at: string | null;
    checked_urls: number;
    http_200: number;
    http_301: number;
    scope_summary: string;
    data_sufficiency: CommercialReport["subject"]["data_sufficiency"];
    limitations: string[];
  };
  technical_scorecard: {
    is_business_score: false;
    overall: { label: string; score: number | null; max_score: number | null; caveat: string };
    dimensions: Array<{ label: string; score: number | null; max_score: number | null; caveat: string }>;
  };
  evidence_index: Array<{
    id: string;
    observed_fact: string;
    source_url: string | null;
    raw_value: string | number | null;
    denominator: number | null;
    source_file?: string;
    source_location?: string;
  }>;
  diagnosis: {
    headline: string;
    verdict: Verdict;
    verdict_reason: string;
    verdict_evidence_ids?: string[];
    strengths: Array<{ text: string; evidence_ids: string[] }>;
    priority_findings: Array<{
      id: string;
      priority: string;
      business_area: string;
      title: string;
      observed_fact: string;
      possible_business_effect: string;
      effect_level: string;
      recommended_action: string;
      acceptance_checks: string[];
      needs_confirmation: string[];
      evidence_ids: string[];
    }>;
    buyer_tasks: Array<{ task: string; status: string; fact: string; what_is_not_known: string; evidence_ids: string[] }>;
    technical_notes: Array<{ label: string; measured_fact: string; significance: string }>;
    not_checked: string[];
  };
  visual_plan: Array<{ id: string; type: string; source_asset: string | null; caption: string; evidence_ids: string[]; visible_disclaimer: string }>;
  conversion: { offer_name: string; offer_scope: string; cta_label: string; cta_request: string; unpromised_fields: string[] };
};

export type ComposeResult =
  | { ok: true; report: CommercialReport; dropped: string[] }
  | { ok: false; code: "ANALYSIS_INVALID"; message: string };

export type EngineScores = {
  overall: { label: string; score: number };
  dimensions: Array<{ label: string; score: number }>;
};

const EMPTY_TABLE_NOTE = /No rows found, please edit your search term\.?/g;
const CHAPTER_AREAS = new Set<string>(CHAPTERS.flatMap((chapter) => [...chapter.areas]));

export function readEngineScores(value: unknown): EngineScores | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { overall?: { name?: unknown; score?: unknown }; categories?: unknown };
  if (typeof record.overall?.score !== "number" || !Number.isFinite(record.overall.score)) return null;
  const dimensions = Array.isArray(record.categories)
    ? record.categories.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const category = item as { name?: unknown; score?: unknown };
        if (typeof category.score !== "number" || !Number.isFinite(category.score)) return [];
        return [{ label: typeof category.name === "string" && category.name.trim() ? category.name.trim() : "分项", score: category.score }];
      })
    : [];
  return {
    overall: { label: typeof record.overall.name === "string" && record.overall.name.trim() ? record.overall.name.trim() : "Overall", score: record.overall.score },
    dimensions,
  };
}

export function certificateTrust(rows: Array<Record<string, unknown>> | undefined): string | null {
  const row = (rows ?? []).find((item) => String(item.info ?? "").trim().toLowerCase() === "trust");
  const value = typeof row?.value === "string" ? row.value.trim() : "";
  return value || null;
}

export function composeCommercialReport(input: {
  analysis: unknown;
  generatedAt: string;
  jobRef?: string;
  synthetic?: boolean;
  scoreScale?: ScoreScale | null;
  htmlOnlyTables?: string[];
  jsonTables?: string[];
  htmlMarkers?: string[];
  engineScores?: EngineScores | null;
  certificateTrust?: string | null;
}): ComposeResult {
  const parsed = parseAnalysis(input.analysis);
  if (!parsed.ok) return parsed;
  const analysis = parsed.analysis;
  const known = new Set(analysis.evidence_index.map((item) => item.id));
  const dropped: string[] = [];
  const keepRefs = (ids: string[], label: string): boolean => {
    if (ids.length > 0 && ids.every((id) => known.has(id))) return true;
    dropped.push(`${label} 没有可回查的证据，已从客户报告去掉。`);
    return false;
  };

  const findings = analysis.diagnosis.priority_findings.flatMap((item) => {
    if (!keepRefs(item.evidence_ids, item.id)) return [];
    const title = scrubClaims(item.title);
    const observed = scrubClaims(item.observed_fact);
    const effect = scrubClaims(item.possible_business_effect);
    const action = scrubClaims(item.recommended_action);
    if (!title || !observed) {
      dropped.push(`${item.id} 去掉材料不能支持的表述后没有可核实事实，已从客户报告去掉。`);
      return [];
    }
    return [{ ...item, title, observed_fact: observed, possible_business_effect: effect, recommended_action: action }];
  });
  const strengths = analysis.diagnosis.strengths.flatMap((item, index) => {
    if (!keepRefs(item.evidence_ids, `strength-${index}`)) return [];
    const text = scrubClaims(item.text);
    if (!text) {
      dropped.push(`strength-${index} 去掉材料不能支持的表述后没有事实，已从客户报告去掉。`);
      return [];
    }
    return [{ text, evidence_ids: item.evidence_ids }];
  });
  const verdictIds = analysis.diagnosis.verdict_evidence_ids ?? [];
  const verdictBacked = verdictIds.length > 0 && verdictIds.every((id) => known.has(id));
  const evidencedChapters = findings.some((item) => CHAPTER_AREAS.has(item.business_area));
  const limited = !evidencedChapters || analysis.source_profile.data_sufficiency === "unusable" || analysis.source_profile.http_200 === 0;
  let verdict = analysis.diagnosis.verdict;
  if (!verdictBacked && verdict !== "no_urgent_action" && verdict !== "further_verification") {
    dropped.push("首屏判断没有完整证据引用，已改为先核实。");
    verdict = "further_verification";
  }
  if (limited && verdict === "site_rebuild_assessment") verdict = "further_verification";
  let headline = scrubClaims(analysis.diagnosis.headline);
  let verdictReason = scrubClaims(analysis.diagnosis.verdict_reason);
  for (const item of analysis.diagnosis.priority_findings) {
    if (findings.some((kept) => kept.id === item.id)) continue;
    headline = removeMention(headline, item.title);
    verdictReason = removeMention(verdictReason, item.title);
  }
  if (!headline) headline = VERDICT_LABEL[verdict];

  const evidenceViews = analysis.evidence_index.map((item) => evidenceView(item, input.htmlOnlyTables ?? [], input.jsonTables ?? [], input.htmlMarkers ?? []));
  const evidenceById = new Map(evidenceViews.map((item) => [item.id, item]));

  const chapters = CHAPTERS.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    findings: findings
      .filter((item) => (chapter.areas as readonly string[]).includes(item.business_area))
      .map((item) => ({
        id: item.id,
        priority: item.priority,
        area: item.business_area,
        title: customerText(item.title),
        observed_fact: customerText(item.observed_fact),
        possible_effect: customerText(item.possible_business_effect),
        effect_level: item.effect_level,
        recommended_action: customerText(item.recommended_action),
        acceptance_checks: item.acceptance_checks.map(customerText),
        needs_confirmation: item.needs_confirmation.map(customerText),
        evidence_ids: item.evidence_ids,
      })),
  }));

  const appendixFindings = findings.filter((item) => item.business_area === "technical_safety" || item.business_area === "accessibility");
  const scale = input.scoreScale ?? null;
  const report: CommercialReport = {
    contract_version: "vfdiag.commercial-report.v1",
    job_ref: input.jobRef ?? "",
    revision: "",
    synthetic: input.synthetic ?? false,
    report_language: "zh",
    generated_at: input.generatedAt,
    subject: {
      domain: analysis.source_profile.target_domain,
      observed_at: analysis.source_profile.observed_at,
      checked_urls: analysis.source_profile.checked_urls,
      http_200: analysis.source_profile.http_200,
      http_301: analysis.source_profile.http_301,
      scope_summary: customerText(analysis.source_profile.scope_summary),
      limitations: analysis.source_profile.limitations.map(customerText),
      data_sufficiency: analysis.source_profile.data_sufficiency,
      limited,
    },
    delivery: {
      profile: "veyfront.overseas-acquisition.v2.1",
      sections: ["overview", "discover", "convince", "connect", "next", "technical_appendix"],
      pdf: { producer: "VEYFRONT", status: "PENDING_VEYFRONT_PRINT", visual_system: "veyfront.report.v2.1" },
    },
    overview: {
      headline: customerText(headline),
      verdict,
      verdict_label: VERDICT_LABEL[verdict],
      verdict_reason: limited
        ? `本次证据只够做有限范围的说明。${customerText(verdictReason)}`
        : customerText(verdictReason),
      strengths: strengths.map((item) => ({ text: customerText(item.text), evidence_ids: item.evidence_ids })),
      buyer_tasks: analysis.diagnosis.buyer_tasks.flatMap((item) => {
        if (!keepRefs(item.evidence_ids, item.task)) return [];
        const fact = scrubClaims(item.fact);
        if (!fact) return [];
        return [{
          task: item.task,
          title: TASK_TITLE[item.task] ?? item.task,
          status: item.status,
          fact: customerText(fact),
          unknown: customerText(item.what_is_not_known),
          evidence_ids: item.evidence_ids,
        }];
      }),
    },
    chapters,
    visuals: analysis.visual_plan.flatMap((item) => {
      if (!keepRefs(item.evidence_ids, item.id)) return [];
      const caption = scrubClaims(item.caption);
      if (!caption) return [];
      return [{
        id: item.id,
        type: item.type,
        caption: customerText(caption),
        disclaimer: customerText(item.visible_disclaimer),
        evidence_ids: item.evidence_ids,
        asset_available: item.type === "real_page_screenshot" && typeof item.source_asset === "string" && item.source_asset.length > 0,
        sources: item.evidence_ids.map((id) => sourceOf(evidenceById.get(id))).filter((item): item is EvidenceSource => item !== null),
      }];
    }),
    next_step: limited
      ? {
          offer_name: "有限范围的网站事实说明",
          offer_scope: "只讨论本次已经采到、并且能对上来源的事实。不据此比较升级方案，也不推断未采集的页面。",
          cta_label: "先确认本次能看到的范围",
          cta_request: "可以补充授权后再做一次更完整的诊断，或先核对本报告里已经标出来源的事实。",
          unpromised_fields: analysis.conversion.unpromised_fields.map(customerText),
          choices: [],
        }
      : {
          offer_name: customerText(scrubClaims(analysis.conversion.offer_name)),
          offer_scope: customerText(scrubClaims(analysis.conversion.offer_scope)),
          cta_label: customerText(scrubClaims(analysis.conversion.cta_label)),
          cta_request: customerText(scrubClaims(analysis.conversion.cta_request)),
          unpromised_fields: analysis.conversion.unpromised_fields.map(customerText),
          choices: findings
            .filter((item) => CHAPTER_AREAS.has(item.business_area))
            .slice(0, 3)
            .map((item) => ({ id: item.id, label: customerText(item.title), area: item.business_area })),
        },
    technical_appendix: {
      is_business_score: false,
      score_scale: scale?.status ?? "NOT_FOUND",
      overall: metric(analysis.technical_scorecard.overall, scale),
      dimensions: analysis.technical_scorecard.dimensions.map((item) => metric(item, scale)),
      notes: [
        ...analysis.diagnosis.technical_notes.map((item) => ({
          label: customerText(item.label),
          fact: customerText(item.measured_fact),
          significance: customerText(item.significance),
        })),
        ...appendixFindings.map((item) => ({
          label: customerText(item.title),
          fact: customerText(item.observed_fact),
          significance: customerText(item.possible_business_effect),
        })),
      ],
      not_checked: analysis.diagnosis.not_checked.map(customerText),
    },
    evidence: evidenceViews,
  };
  applyMeasuredFacts(report, input.engineScores ?? null, input.certificateTrust ?? null);
  report.revision = createHash("sha256").update(JSON.stringify({ ...report, revision: "" })).digest("hex");
  return { ok: true, report, dropped };
}

function mentionsTable(location: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`TABLE\\s+${escaped}(?![\\w-])`).test(location);
}

function evidenceView(
  item: Analysis["evidence_index"][number],
  htmlOnly: string[],
  jsonTables: string[],
  htmlMarkers: string[],
): EvidenceView {
  const location = typeof item.source_location === "string" ? item.source_location : "";
  const claimed = typeof item.source_file === "string" ? item.source_file.trim() : "";
  const htmlHit = htmlOnly.some((name) => mentionsTable(location, name)) || htmlMarkers.some((name) => location.includes(name));
  const jsonHit = jsonTables.some((name) => mentionsTable(location, name));
  const stamped = claimed === "" || claimed === "siteone.json" || claimed === "siteone.html";
  let sourceFile = claimed;
  if (htmlHit && jsonHit && stamped) sourceFile = "siteone.html+siteone.json";
  else if (htmlHit && (claimed === "" || claimed === "siteone.json")) sourceFile = "siteone.html";
  else if (jsonHit && (claimed === "" || claimed === "siteone.html")) sourceFile = "siteone.json";
  else if (!sourceFile) sourceFile = "siteone.json";
  return {
    id: item.id,
    evidence_id: item.id,
    fact: customerText(item.observed_fact),
    url: item.source_url,
    raw_value: item.raw_value,
    denominator: item.denominator,
    source_file: sourceFile,
    source_location: location,
  };
}

function sourceOf(item: EvidenceView | undefined): EvidenceSource | null {
  if (!item) return null;
  return {
    evidence_id: item.id,
    source_file: item.source_file,
    source_location: item.source_location,
    url: item.url,
    raw_value: item.raw_value,
  };
}

function applyMeasuredFacts(report: CommercialReport, scores: EngineScores | null, trust: string | null): void {
  replaceText(report);
  if (scores) {
    report.technical_appendix.overall = {
      label: `${scores.overall.label}（检测引擎技术分）`,
      score: scores.overall.score,
      max_score: report.technical_appendix.overall.max_score ?? 10,
      caveat: "这是检测引擎给出的技术分，不是获客能力评分，也不据此决定是否重建。",
    };
    report.technical_appendix.dimensions = scores.dimensions.map((item) => ({
      label: item.label,
      score: item.score,
      max_score: report.technical_appendix.overall.max_score,
      caveat: "分项技术分，不换算成获客能力。",
    }));
    report.subject.limitations = report.subject.limitations.filter((item) => !/质量分|技术评分结论/.test(item));
    report.technical_appendix.not_checked = report.technical_appendix.not_checked.filter((item) => !/质量分分值|技术评分结论/.test(item));
  }
  if (trust && /trusted by system ca store/i.test(trust)) {
    report.subject.limitations = report.subject.limitations.filter((item) => !/证书链信任校验结果未能|Trust 行文本存在歧义/.test(item));
    report.technical_appendix.notes = report.technical_appendix.notes.map((note) => {
      if (!/信任校验|No rows found|未能从材料确认/.test(`${note.label} ${note.fact} ${note.significance}`)) return note;
      return {
        label: "证书信任",
        fact: "证书表 Trust 为 Trusted by system CA store。",
        significance: "系统信任库接受这张证书。这只说明证书链被信任，不说明网站内容可信。",
      };
    });
    report.evidence = report.evidence.map((item) => {
      if (!/No rows found|未能从材料确认|无法从材料确认/.test(item.fact)) return item;
      if (!/Trust|信任/.test(item.fact)) return item;
      return { ...item, fact: "证书表 Trust 为 Trusted by system CA store。", raw_value: trust };
    });
  }
}

function replaceText(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((item) => replaceText(item));
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" && item.includes("No rows found")) {
      record[key] = item.replace(EMPTY_TABLE_NOTE, "").replace(/[ \t]{2,}/g, " ").trim();
    } else {
      replaceText(item);
    }
  }
}

export function fillUnstatedCounts(analysis: unknown, counts: { checked: number; http200: number; http301: number }): unknown {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) return analysis;
  const record = analysis as { source_profile?: unknown };
  if (!record.source_profile || typeof record.source_profile !== "object" || Array.isArray(record.source_profile)) return analysis;
  const profile = record.source_profile as Record<string, unknown>;
  return {
    ...record,
    source_profile: {
      ...profile,
      checked_urls: profile.checked_urls ?? counts.checked,
      http_200: profile.http_200 ?? counts.http200,
      http_301: profile.http_301 ?? counts.http301,
    },
  };
}

export function sameSite(domain: string, host: string): boolean {
  const left = domain.trim().toLowerCase().replace(/^www\./, "");
  const right = host.trim().toLowerCase().replace(/^www\./, "");
  return left.length > 0 && left === right;
}

export function sourceCountMismatch(analysis: unknown, counts: { checked: number; http200: number; http301: number }): string | null {
  const parsed = parseAnalysis(analysis);
  if (!parsed.ok) return parsed.message;
  const profile = parsed.analysis.source_profile;
  if (profile.checked_urls !== counts.checked || profile.http_200 !== counts.http200 || profile.http_301 !== counts.http301) {
    return "分析里的访问数量和本次扫描结果不一致，客户报告未发布。";
  }
  return null;
}

export function countResponses(results: Array<{ url?: unknown; status?: unknown }> | undefined): { checked: number; http200: number; http301: number } {
  const rows = (results ?? []).filter((row) => typeof row.url === "string" && /^https?:\/\//.test(row.url));
  const status = (row: { status?: unknown }) => (typeof row.status === "string" ? row.status : "");
  return {
    checked: rows.length,
    http200: rows.filter((row) => status(row).startsWith("200")).length,
    http301: rows.filter((row) => status(row).startsWith("301")).length,
  };
}

function metric(item: { label: string; score: number | null; max_score: number | null; caveat: string }, scale: ScoreScale | null): MetricView {
  const filled = item.max_score === null && scale?.status === "DETERMINED" ? scale.max_score : item.max_score;
  const conflict = scale?.status === "DETERMINED" && item.max_score !== null && item.max_score !== scale.max_score;
  return {
    label: customerText(item.label),
    score: conflict ? null : item.score,
    max_score: conflict ? null : filled,
    caveat: conflict ? "模型填写的满分和报告图形不一致，这项分数不放进客户报告。" : customerText(item.caveat),
  };
}

function customerText(value: string): string {
  return value.replace(/SiteOne/gi, "本次检测").replace(/VF-?DIAG/gi, "诊断服务");
}

function scrubClaims(text: string): string {
  return text
    .split(/(?<=[。！？\n])/)
    .filter((part) => part.trim() && !unsupportedSentence(part))
    .join("")
    .trim();
}

function removeMention(text: string, title: string): string {
  const needle = title.trim().slice(0, 24);
  if (needle.length < 4) return text;
  return text
    .split(/(?<=[。！？\n])/)
    .filter((part) => !part.includes(needle))
    .join("")
    .trim();
}

function unsupportedSentence(sentence: string): boolean {
  const claim = /搜索排名|询盘量|询盘数|真实流量|收入增长|收入达到|采购结果|保证.{0,16}(排名|询盘|流量|收入)/;
  if (!claim.test(sentence)) return false;
  const denies = /不承诺|未检测|不是|不代表|没有|未读取|未验证|不预测|不能|不会|不可/;
  const asserts = /已经|达到|第一|翻倍|增长|排名第|将会|可以带来/;
  return !(denies.test(sentence) && !asserts.test(sentence));
}

function parseAnalysis(input: unknown): { ok: true; analysis: Analysis } | { ok: false; code: "ANALYSIS_INVALID"; message: string } {
  if (!input || typeof input !== "object") return invalid("分析不是对象。");
  const record = input as Record<string, unknown>;
  if (record.schema_version !== "veyfront.report-analysis.v0.1" || record.mode !== "validation") return invalid("分析版本不对。");
  const profile = record.source_profile;
  const diagnosis = record.diagnosis;
  const scorecard = record.technical_scorecard;
  const conversion = record.conversion;
  if (!isRecord(profile) || !isRecord(diagnosis) || !isRecord(scorecard) || !isRecord(conversion)) return invalid("分析缺少来源、判断或下一步。");
  if (typeof profile.target_domain !== "string" || typeof profile.scope_summary !== "string") return invalid("分析缺少网站或范围说明。");
  if (!isCount(profile.checked_urls) || !isCount(profile.http_200) || !isCount(profile.http_301)) return invalid("分析里的访问数量不是整数。");
  if (profile.data_sufficiency !== "adequate_for_limited_report" && profile.data_sufficiency !== "partial" && profile.data_sufficiency !== "unusable") {
    return invalid("分析的证据充分性取值无效。");
  }
  if (scorecard.is_business_score !== false) return invalid("技术评分不能当成获客评分。");
  if (typeof diagnosis.headline !== "string" || typeof diagnosis.verdict_reason !== "string") return invalid("分析缺少标题或判断理由。");
  if (!VERDICTS.includes(diagnosis.verdict as Verdict)) return invalid("分析的结论取值无效。");
  if (!Array.isArray(record.evidence_index) || !Array.isArray(diagnosis.priority_findings) || !Array.isArray(diagnosis.strengths)) return invalid("分析缺少证据或发现。");
  const ids = record.evidence_index.map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : ""));
  if (ids.some((id) => !/^E[0-9]{2,3}$/.test(id)) || new Set(ids).size !== ids.length) return invalid("证据编号无效或重复。");
  return { ok: true, analysis: input as Analysis };
}

function invalid(message: string): { ok: false; code: "ANALYSIS_INVALID"; message: string } {
  return { ok: false, code: "ANALYSIS_INVALID", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
