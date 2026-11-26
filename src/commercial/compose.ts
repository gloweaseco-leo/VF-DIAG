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
  visuals: Array<{ id: string; type: string; caption: string; disclaimer: string; evidence_ids: string[]; asset_available: boolean }>;
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
  evidence: Array<{ id: string; fact: string; url: string | null; raw_value: string | number | null; denominator: number | null }>;
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
  evidence_index: Array<{ id: string; observed_fact: string; source_url: string | null; raw_value: string | number | null; denominator: number | null }>;
  diagnosis: {
    headline: string;
    verdict: Verdict;
    verdict_reason: string;
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

export function composeCommercialReport(input: {
  analysis: unknown;
  generatedAt: string;
  scoreScale?: ScoreScale | null;
}): ComposeResult {
  const parsed = parseAnalysis(input.analysis);
  if (!parsed.ok) return parsed;
  const analysis = parsed.analysis;
  const known = new Set(analysis.evidence_index.map((item) => item.id));
  const dropped: string[] = [];
  const keepRefs = (ids: string[], label: string): boolean => {
    if (ids.every((id) => known.has(id))) return true;
    dropped.push(`${label} 引用了材料里没有的证据，已从客户报告去掉。`);
    return false;
  };
  const keepText = (text: string, label: string): boolean => {
    if (!unsupportedClaim(text)) return true;
    dropped.push(`${label} 含有材料不能支持的流量、排名、询盘或收入表述，已从客户报告去掉。`);
    return false;
  };

  const findings = analysis.diagnosis.priority_findings.filter((item) => {
    const blob = [item.title, item.observed_fact, item.possible_business_effect, item.recommended_action].join("\n");
    return keepRefs(item.evidence_ids, item.id) && keepText(blob, item.id);
  });
  const strengths = analysis.diagnosis.strengths.filter((item, index) => keepRefs(item.evidence_ids, `strength-${index}`) && keepText(item.text, `strength-${index}`));
  const thin = analysis.source_profile.data_sufficiency === "unusable" || analysis.source_profile.http_200 === 0 || (findings.length === 0 && strengths.length === 0);
  let verdict = analysis.diagnosis.verdict;
  if (thin && verdict === "site_rebuild_assessment") verdict = "further_verification";

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
      limited: thin,
    },
    delivery: {
      profile: "veyfront.overseas-acquisition.v2.1",
      sections: ["overview", "discover", "convince", "connect", "next", "technical_appendix"],
      pdf: { producer: "VEYFRONT", status: "PENDING_VEYFRONT_PRINT", visual_system: "veyfront.report.v2.1" },
    },
    overview: {
      headline: customerText(analysis.diagnosis.headline),
      verdict,
      verdict_label: VERDICT_LABEL[verdict],
      verdict_reason: thin
        ? `本次证据只够做有限范围的说明。${customerText(analysis.diagnosis.verdict_reason)}`
        : customerText(analysis.diagnosis.verdict_reason),
      strengths: strengths.map((item) => ({ text: customerText(item.text), evidence_ids: item.evidence_ids })),
      buyer_tasks: analysis.diagnosis.buyer_tasks
        .filter((item) => keepRefs(item.evidence_ids, item.task) && keepText(item.fact, item.task))
        .map((item) => ({
          task: item.task,
          title: TASK_TITLE[item.task] ?? item.task,
          status: item.status,
          fact: customerText(item.fact),
          unknown: customerText(item.what_is_not_known),
          evidence_ids: item.evidence_ids,
        })),
    },
    chapters,
    visuals: analysis.visual_plan
      .filter((item) => keepRefs(item.evidence_ids, item.id) && keepText(item.caption, item.id))
      .map((item) => ({
        id: item.id,
        type: item.type,
        caption: customerText(item.caption),
        disclaimer: customerText(item.visible_disclaimer),
        evidence_ids: item.evidence_ids,
        asset_available: item.type === "real_page_screenshot" && typeof item.source_asset === "string" && item.source_asset.length > 0,
      })),
    next_step: thin
      ? {
          offer_name: "有限范围的网站事实说明",
          offer_scope: "只讨论本次已经采到、并且能对上来源的事实。不据此比较升级方案，也不推断未采集的页面。",
          cta_label: "先确认本次能看到的范围",
          cta_request: "可以补充授权后再做一次更完整的诊断，或先核对本报告里已经标出来源的事实。",
          unpromised_fields: analysis.conversion.unpromised_fields.map(customerText),
          choices: [],
        }
      : {
          offer_name: customerText(analysis.conversion.offer_name),
          offer_scope: customerText(analysis.conversion.offer_scope),
          cta_label: customerText(analysis.conversion.cta_label),
          cta_request: customerText(analysis.conversion.cta_request),
          unpromised_fields: analysis.conversion.unpromised_fields.map(customerText),
          choices: findings.slice(0, 3).map((item) => ({ id: item.id, label: customerText(item.title), area: item.business_area })),
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
    evidence: analysis.evidence_index.map((item) => ({
      id: item.id,
      fact: customerText(item.observed_fact),
      url: item.source_url,
      raw_value: item.raw_value,
      denominator: item.denominator,
    })),
  };
  return { ok: true, report, dropped };
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

function unsupportedClaim(text: string): boolean {
  if (/不承诺|未检测|不是|不代表|没有|未读取|未验证/.test(text)) return false;
  return /搜索排名|询盘量|询盘数|真实流量|收入增长|收入达到|采购结果|保证.{0,16}(排名|询盘|流量|收入)/.test(text);
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
