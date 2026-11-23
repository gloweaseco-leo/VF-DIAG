import {
  AI_VISIBILITY_STATEMENT,
  CONTRACT_VERSION,
  ENGINE,
  MAX_DEPTH,
  MAX_URLS,
  REPORT_LANGUAGE,
  REPORT_SCHEMA_VERSION,
  REPORT_TIMEZONE,
  RETENTION_DAYS,
  SCAN_SCOPE,
} from "../constants.ts";
import type {
  Advantage,
  BuyerTask,
  ClaimLevel,
  CustomerReport,
  Priority,
  SiteOneJson,
  SourceRef,
} from "./types.ts";

export type ProjectInput = {
  jobRef: string;
  inputUrl: string;
  host: string;
  synthetic: boolean;
  generatedAt: string;
  siteone: SiteOneJson;
  engineVersion: string | null;
};

export type ProjectResult =
  | { ok: true; report: CustomerReport }
  | { ok: false; code: "UNSAFE_OFFHOST"; message: string };

type Page = {
  url: string;
  path: string;
  status: string;
  title: string;
  description: string;
  h1: string;
  robotsIndex: string | null;
};

export function projectReport(input: ProjectInput): ProjectResult {
  const origin = originOf(input.inputUrl);
  const pages = collectPages(input.siteone, origin);
  const offHost = pages.find((page) => isHttp(page.url) && hostOf(page.url) !== input.host);
  const offHost404 = (input.siteone.tables?.["404"]?.rows ?? [])
    .map((row) => absoluteUrl(stringOrNull(row.url), origin))
    .find((url) => url && isHttp(url) && hostOf(url) !== input.host);
  if (offHost || offHost404) {
    return {
      ok: false,
      code: "UNSAFE_OFFHOST",
      message: "扫描结果里出现了目标域名以外的已请求地址，报告未发布。",
    };
  }

  const observedAt = stringOrNull(input.siteone.crawler?.executedAt);
  const source = (field: string, sourceUrl: string | null, targetUrl: string | null, excerpt: string | null): SourceRef => ({
    source_url: sourceUrl,
    target_url: targetUrl,
    source_field: field,
    excerpt,
    observed_at: observedAt,
    observed_at_has_timezone: false,
    scope: SCAN_SCOPE,
  });

  const productPages = pages.filter((page) => isProductPath(page.path));
  const contactPages = pages.filter((page) => isContactPath(page.path));
  const productOk = productPages.find((page) => page.status === "200");
  const contactOk = contactPages.find((page) => page.status === "200");
  const productBroken = brokenLinks(input.siteone, origin, input.host, isProductPath);
  const contactBroken = brokenLinks(input.siteone, origin, input.host, isContactPath);
  const channels = channelsFrom(input.siteone, input.host);

  const reasonCodes = ["HTML_ONLY_NO_BROWSER"];
  if (!productOk && productBroken.length === 0) reasonCodes.push("PRODUCT_NOT_IN_SAMPLE");
  if (!contactOk && contactBroken.length === 0) reasonCodes.push("CONTACT_NOT_IN_SAMPLE");
  if (productOk && !productOk.description && !productOk.h1) reasonCodes.push("SPECS_UNREAD");

  const scanned = numberOrNull(input.siteone.stats?.totalUrls) ?? pages.length;
  const evidenceGap = reasonCodes.includes("PRODUCT_NOT_IN_SAMPLE") || reasonCodes.includes("CONTACT_NOT_IN_SAMPLE");
  const partial = evidenceGap || productBroken.length > 0 || contactBroken.length > 0;

  const priorities = buildPriorities(productBroken, contactBroken, source);
  const advantages = buildAdvantages(productOk, contactOk, pages, source);
  const next = chooseNext(productBroken, contactBroken, productOk, contactOk);
  const language = languageOf(pages, source);
  const domain = input.host;

  const summary = summaryOf({
    domain,
    productOk,
    contactOk,
    productBroken,
    contactBroken,
    evidenceGap,
  });

  const report: CustomerReport = {
    contract_version: CONTRACT_VERSION,
    report_schema_version: REPORT_SCHEMA_VERSION,
    report_language: REPORT_LANGUAGE,
    synthetic: input.synthetic,
    job_ref: input.jobRef,
    engine: ENGINE,
    engine_version: input.engineVersion ?? "unknown",
    target: { input_url: input.inputUrl, host: input.host },
    generated_at: input.generatedAt,
    timezone: REPORT_TIMEZONE,
    retention_days: RETENTION_DAYS,
    headline: {
      domain,
      scanned_at: observedAt,
      status: partial ? "partial" : "complete",
      summary,
    },
    ai_visibility: { status: "NOT_CHECKED", statement: AI_VISIBILITY_STATEMENT },
    coverage: {
      scanned_pages: scanned,
      max_urls: MAX_URLS,
      max_depth: MAX_DEPTH,
      partial,
      reason_codes: reasonCodes,
      statement: partial ? "本结论仅针对已检查页面。采样不足的部分不能当成网站缺陷。" : "本结论仅针对已检查页面。",
    },
    advantages,
    buyer_tasks: {
      find: findTask(pages, productBroken, source),
      understand: understandTask(productOk, productBroken, source),
      contact: contactTask(contactOk, contactBroken, channels, source),
    },
    product_observation: productObservation(productOk, productBroken, source),
    contact_observation: contactObservation(contactOk, contactBroken, source),
    language_observation: language,
    contact_channel_observation: {
      status: channels.length > 0 ? "OBSERVED" : contactOk ? "NEEDS_CONFIRMATION" : "NOT_CHECKED",
      channels,
      statement: channelStatement(channels, contactOk),
      source: source(
        "tables.external-urls.rows",
        contactOk?.url ?? null,
        channels[0]?.url ?? null,
        channels.map((item) => item.url).join(" ") || null,
      ),
    },
    priorities,
    recommended_next_step: next.step,
    next_step_reason: next.reason,
    primary_action: next.action,
    share_blurb: shareBlurb(domain, priorities),
    artifact_kinds: ["html", "json"],
  };
  return { ok: true, report };
}

function summaryOf(input: {
  domain: string;
  productOk: Page | undefined;
  contactOk: Page | undefined;
  productBroken: Broken[];
  contactBroken: Broken[];
  evidenceGap: boolean;
}): string {
  const ai = AI_VISIBILITY_STATEMENT;
  if (input.productBroken[0]) {
    return `采样里有一条已证实的产品链接返回 404。${input.contactOk ? "联系页本次可以打开。" : ""}${ai}`;
  }
  if (input.contactBroken[0]) {
    return `采样里有一条已证实的联系链接返回 404。${ai}`;
  }
  if (input.productOk && input.contactOk) {
    return `本次检查到的产品页和联系页都能打开。没有已证实的优先障碍。${ai}`;
  }
  if (input.evidenceGap) {
    return `这次只确认了已抓到的页面。产品和联系入口里，至少有一项还不能核实。${ai}`;
  }
  return `本次扫描已结束。${ai}`;
}

function chooseNext(
  productBroken: Broken[],
  contactBroken: Broken[],
  productOk: Page | undefined,
  contactOk: Page | undefined,
): { step: CustomerReport["recommended_next_step"]; reason: string; action: CustomerReport["primary_action"] } {
  if (productBroken.length > 0 && contactBroken.length > 0) {
    return {
      step: "SPECIAL_UPGRADE",
      reason: "产品路径和联系路径都有已证实的 404，这是两条相关的买家路径障碍，可以讨论集中处理。这不是重建结论。",
      action: { label: "讨论网站升级", kind: "rebuild" },
    };
  }
  if (productBroken.length > 0 || contactBroken.length > 0) {
    return {
      step: "LOCAL_OPTIMIZE",
      reason: "已证实的问题是单个链接返回 404，可以单独修复后复查。技术分和标题层级没有参与这个判断。",
      action: { label: "查看这条证据", kind: "evidence" },
    };
  }
  if (productOk && contactOk) {
    return {
      step: "KEEP",
      reason: "本次采样内，选中的产品页和联系页都返回 200。没有已证实的买家路径阻断。采样之外的页面仍未检查。",
      action: { label: "查看专业明细", kind: "artifact" },
    };
  }
  return {
    step: "CONFIRM_FIRST",
    reason: "采样里还不能同时核实产品页和联系入口。先补查，再决定要不要改网站。",
    action: { label: "查看本次范围", kind: "coverage" },
  };
}

function buildPriorities(
  productBroken: Broken[],
  contactBroken: Broken[],
  source: (field: string, sourceUrl: string | null, targetUrl: string | null, excerpt: string | null) => SourceRef,
): Priority[] {
  const items: Priority[] = [];
  for (const broken of productBroken) {
    items.push({
      id: `product-404-${items.length + 1}`,
      title: "一条产品链接打不开",
      claim_level: "OBSERVED",
      fact: `本次从 ${broken.sourceUrl ?? "已检查页面"} 发现的链接 ${broken.url} 返回 404。`,
      impact: "通过这条链接继续看产品的采购员，可能到不了详情页。",
      impact_level: "INFERRED",
      suggestion: "核对这条链接和对应产品页，修复后用同范围再扫一次。",
      needs_confirmation: "该链接是不是还在用的主产品入口，需要网站管理者确认。",
      buyer_step: "understand",
      source: source("tables.404.rows", broken.sourceUrl, broken.url, "404"),
    });
  }
  for (const broken of contactBroken) {
    items.push({
      id: `contact-404-${items.length + 1}`,
      title: "一条联系链接打不开",
      claim_level: "OBSERVED",
      fact: `本次从 ${broken.sourceUrl ?? "已检查页面"} 发现的链接 ${broken.url} 返回 404。`,
      impact: "沿着这条链接想询盘的采购员，可能到不了联系页。",
      impact_level: "INFERRED",
      suggestion: "核对联系入口地址，修复后复查。本次没有提交表单。",
      needs_confirmation: "站上是否还有邮箱、WhatsApp 或其他入口，需要网站管理者确认。",
      buyer_step: "contact",
      source: source("tables.404.rows", broken.sourceUrl, broken.url, "404"),
    });
  }
  return items.slice(0, 3);
}

function buildAdvantages(
  productOk: Page | undefined,
  contactOk: Page | undefined,
  pages: Page[],
  source: (field: string, sourceUrl: string | null, targetUrl: string | null, excerpt: string | null) => SourceRef,
): Advantage[] {
  const items: Advantage[] = [];
  if (productOk) {
    items.push({
      id: "product-reachable",
      title: "抽到的产品页可以打开",
      claim_level: "OBSERVED",
      fact: `本次访问 ${productOk.url} 返回 200。${productOk.title ? `标题为「${clip(productOk.title, 80)}」。` : "没有读到标题。"}`,
      source: source("results", productOk.url, productOk.url, productOk.title || null),
    });
  }
  if (contactOk) {
    items.push({
      id: "contact-reachable",
      title: "抽到的联系页可以打开",
      claim_level: "OBSERVED",
      fact: `本次访问 ${contactOk.url} 返回 200。这不能说明表单已提交或邮件已送达。`,
      source: source("results", contactOk.url, contactOk.url, contactOk.title || null),
    });
  }
  if (items.length === 0) {
    const home = pages.find((page) => page.status === "200" && (page.path === "/" || page.path.endsWith("/index.html")));
    if (home) {
      items.push({
        id: "home-reachable",
        title: "首页本次可以打开",
        claim_level: "OBSERVED",
        fact: `本次访问 ${home.url} 返回 200。`,
        source: source("results", home.url, home.url, home.title || null),
      });
    }
  }
  return items.slice(0, 3);
}

function findTask(pages: Page[], productBroken: Broken[], source: SourceRefFactory): BuyerTask {
  const ok = pages.filter((page) => page.status === "200").length;
  if (productBroken[0]) {
    const broken = productBroken[0];
    return {
      question: "海外买家能找到吗？",
      status: "OBSERVED",
      fact: `本次抓到 ${ok} 个返回 200 的地址，同时 ${broken.url} 返回 404。这不是搜索排名。`,
      impact: "已经点到这条失效链接的人会中断。没有证据说明搜索或 AI 是否展示了这个网站。",
      impact_level: "INFERRED",
      suggestion: "先修这条失效链接，再谈收录。",
      source: source("tables.404.rows", broken.sourceUrl, broken.url, "404"),
    };
  }
  if (ok > 0) {
    return {
      question: "海外买家能找到吗？",
      status: "OBSERVED",
      fact: `本次有 ${ok} 个地址返回 200。没有把这当成搜索排名或 AI 引用。`,
      impact: "只能说明采样内的地址当时能打开。",
      impact_level: "INFERRED",
      suggestion: "排名和 AI 引用需要授权后的搜索平台数据，本次未检测。",
      source: source("results", pages.find((page) => page.status === "200")?.url ?? null, null, null),
    };
  }
  return emptyTask("海外买家能找到吗？", "本次没有确认到返回 200 的页面。", source("results", null, null, null));
}

function understandTask(productOk: Page | undefined, productBroken: Broken[], source: SourceRefFactory): BuyerTask {
  if (productOk) {
    const excerpt = productOk.description || productOk.h1;
    return {
      question: "海外买家能看懂吗？",
      status: "OBSERVED",
      fact: excerpt
        ? `产品页 ${productOk.url} 可以打开。读到的文字是「${clip(excerpt, 180)}」。规格是否完整，本次没有核验。`
        : `产品页 ${productOk.url} 可以打开，但没有读到简介或一级标题。规格未核查，也不能判断内容是不是主要在图片里。`,
      impact: excerpt
        ? "采购员至少能看到这段文字。看不到的型号仍然未知。"
        : "如果规格只画在图片里，这次扫描读不到。",
      impact_level: "INFERRED",
      suggestion: "用原文核对名称和关键规格。图片里的参数需要人工确认。",
      source: source("tables.seo.rows", productOk.url, productOk.url, excerpt || null),
    };
  }
  if (productBroken[0]) {
    return {
      question: "海外买家能看懂吗？",
      status: "OBSERVED",
      fact: `抽到的产品链接 ${productBroken[0].url} 返回 404，所以本次没有读到该页规格。`,
      impact: "走这条链接的人看不到产品说明。",
      impact_level: "INFERRED",
      suggestion: "先恢复页面，再核对规格是文字还是图片。",
      source: source("tables.404.rows", productBroken[0].sourceUrl, productBroken[0].url, "404"),
    };
  }
  return emptyTask("海外买家能看懂吗？", "当前采样未发现可确认的产品页。", source("tables.seo.rows", null, null, null));
}

function contactTask(
  contactOk: Page | undefined,
  contactBroken: Broken[],
  channels: CustomerReport["contact_channel_observation"]["channels"],
  source: SourceRefFactory,
): BuyerTask {
  if (contactBroken[0] && !contactOk) {
    return {
      question: "海外买家能联系吗？",
      status: "OBSERVED",
      fact: `联系链接 ${contactBroken[0].url} 返回 404。本次没有提交询盘。`,
      impact: "只走这条链接的采购员可能找不到入口。其他渠道是否存在，本次未知。",
      impact_level: "INFERRED",
      suggestion: "修复链接，并确认邮箱或 WhatsApp 是否另外公开。",
      source: source("tables.404.rows", contactBroken[0].sourceUrl, contactBroken[0].url, "404"),
    };
  }
  if (contactOk) {
    const channelText = channels.length
      ? `外链里看到：${channels.map((item) => `${item.type} ${item.url}`).join("，")}。`
      : "外链里没有看到邮箱、电话、WhatsApp 或微信。";
    return {
      question: "海外买家能联系吗？",
      status: "OBSERVED",
      fact: `联系页 ${contactOk.url} 返回 ${contactOk.status}。${channelText}页面能打开不等于表单可以提交。`,
      impact: "采购员可能找得到这个页面。是否有人回复，本次没有验证。",
      impact_level: "INFERRED",
      suggestion: "由销售确认这个入口是否仍在使用。",
      source: source("results", contactOk.url, contactOk.url, contactOk.title || null),
    };
  }
  return emptyTask("海外买家能联系吗？", "本次未找到可核实的联系或询盘入口。", source("results", null, null, null));
}

function productObservation(
  productOk: Page | undefined,
  productBroken: Broken[],
  source: SourceRefFactory,
): CustomerReport["product_observation"] {
  if (productOk) {
    const excerpt = productOk.description || null;
    return {
      status: "OBSERVED",
      url: productOk.url,
      title: productOk.title || null,
      excerpt,
      http_status: "200",
      specs_status: excerpt ? "NEEDS_CONFIRMATION" : "NOT_CHECKED",
      specs_note: excerpt
        ? "只引用了页面简介原文，没有核验型号、压力、材质或其他参数是否齐全。"
        : "只核实页面可访问，未核实规格。简介为空时，规格可能在图片中。",
      source: source("tables.seo.rows", productOk.url, productOk.url, excerpt),
    };
  }
  if (productBroken[0]) {
    return {
      status: "OBSERVED",
      url: productBroken[0].url,
      title: null,
      excerpt: null,
      http_status: "404",
      specs_status: "NOT_CHECKED",
      specs_note: "链接返回 404，规格未核查。",
      source: source("tables.404.rows", productBroken[0].sourceUrl, productBroken[0].url, "404"),
    };
  }
  return {
    status: "NOT_CHECKED",
    url: null,
    title: null,
    excerpt: null,
    http_status: null,
    specs_status: "NOT_CHECKED",
    specs_note: "当前采样未发现可确认的产品页。",
    source: source("tables.seo.rows", null, null, null),
  };
}

function contactObservation(
  contactOk: Page | undefined,
  contactBroken: Broken[],
  source: SourceRefFactory,
): CustomerReport["contact_observation"] {
  if (contactOk) {
    return {
      status: "OBSERVED",
      url: contactOk.url,
      title: contactOk.title || null,
      http_status: contactOk.status,
      source: source("results", contactOk.url, contactOk.url, contactOk.title || null),
    };
  }
  if (contactBroken[0]) {
    return {
      status: "OBSERVED",
      url: contactBroken[0].url,
      title: null,
      http_status: "404",
      source: source("tables.404.rows", contactBroken[0].sourceUrl, contactBroken[0].url, "404"),
    };
  }
  return {
    status: "NOT_CHECKED",
    url: null,
    title: null,
    http_status: null,
    source: source("results", null, null, null),
  };
}

function languageOf(pages: Page[], source: SourceRefFactory): CustomerReport["language_observation"] {
  const text = pages.map((page) => `${page.title} ${page.description} ${page.h1}`).join(" ");
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const sampled = pages.filter((page) => page.title || page.description || page.h1).length;
  if (cjk === 0 && latin === 0) {
    return {
      status: "NOT_CHECKED",
      sampled_pages: sampled,
      cjk_chars: 0,
      latin_letters: 0,
      fact: "抽到的标题和简介里没有可读文字，不能判断语言。",
      inference: "",
      inference_level: "NOT_CHECKED",
      source: source("tables.seo.rows", pages[0]?.url ?? null, null, null),
    };
  }
  return {
    status: "OBSERVED",
    sampled_pages: sampled,
    cjk_chars: cjk,
    latin_letters: latin,
    fact: `已检查页面的标题和简介里，汉字 ${cjk} 个，拉丁字母 ${latin} 个。`,
    inference: cjk > latin ? "如果正文同样以中文为主，海外采购员可能无法直接阅读。" : "标题和简介里拉丁字母不少于汉字。正文是否足够清楚，仍需看具体页面。",
    inference_level: "INFERRED",
    source: source("tables.seo.rows", pages[0]?.url ?? null, null, clip(text.trim(), 180)),
  };
}

function channelStatement(
  channels: CustomerReport["contact_channel_observation"]["channels"],
  contactOk: Page | undefined,
): string {
  if (channels.length === 0 && contactOk) {
    return "只发现联系页面，未在外链中看到邮箱、电话、WhatsApp 或微信。页面返回 200 不能证明表单可以提交。";
  }
  if (channels.length === 0) {
    return "本次未在外链中看到邮箱、电话、WhatsApp 或微信。";
  }
  const hasWechat = channels.some((item) => item.type === "wechat");
  const base = `看到的联系方式只表示链接存在，不表示已经送达或有人回复。`;
  return hasWechat ? `${base}微信链接不能写成欧美采购员可以直接使用。` : base;
}

function shareBlurb(domain: string, priorities: Priority[]): string {
  const head = `网站 ${domain}。本次是授权声明后的公开页面扫描，不是排名，也未检测 AI 是否引用。`;
  if (!priorities[0]) return `${head}本次没有已证实的优先障碍；采样不足的项目需要再核实。`;
  return `${head}优先事项：${priorities[0].fact}`;
}

function emptyTask(question: string, fact: string, source: SourceRef): BuyerTask {
  return {
    question,
    status: "NOT_CHECKED",
    fact,
    impact: "本次样本不够，不能判断对买家的影响。",
    impact_level: "NOT_CHECKED",
    suggestion: "扩大已授权的采样，或由网站管理者指出主产品页和联系页。",
    source,
  };
}

type SourceRefFactory = (field: string, sourceUrl: string | null, targetUrl: string | null, excerpt: string | null) => SourceRef;

type Broken = { url: string; sourceUrl: string | null };

function brokenLinks(
  siteone: SiteOneJson,
  origin: string,
  host: string,
  match: (path: string) => boolean,
): Broken[] {
  const rows = siteone.tables?.["404"]?.rows ?? [];
  const found: Broken[] = [];
  for (const row of rows) {
    const url = absoluteUrl(stringOrNull(row.url), origin);
    if (!url || hostOf(url) !== host) continue;
    const path = pathOf(url);
    if (!match(path)) continue;
    const sourceRaw = stringOrNull(row.sourceUqId);
    found.push({ url, sourceUrl: sourceRaw ? absoluteUrl(sourceRaw, origin) : null });
  }
  return found.sort((a, b) => a.url.localeCompare(b.url));
}

function channelsFrom(siteone: SiteOneJson, host: string): CustomerReport["contact_channel_observation"]["channels"] {
  const rows = siteone.tables?.["external-urls"]?.rows ?? [];
  const channels: CustomerReport["contact_channel_observation"]["channels"] = [];
  for (const row of rows) {
    const url = stringOrNull(row.url);
    if (!url) continue;
    const type = channelType(url);
    if (!type) continue;
    if (channels.some((item) => item.url === url)) continue;
    channels.push({ type, url });
  }
  void host;
  return channels.slice(0, 6);
}

function channelType(url: string): "email" | "phone" | "whatsapp" | "wechat" | null {
  const value = url.toLowerCase();
  if (value.startsWith("mailto:")) return "email";
  if (value.startsWith("tel:")) return "phone";
  if (value.includes("wa.me/") || value.includes("whatsapp.com/") || value.startsWith("whatsapp:")) return "whatsapp";
  if (value.startsWith("weixin:") || value.includes("u.wechat.com") || value.includes("work.weixin.qq.com")) return "wechat";
  return null;
}

function collectPages(siteone: SiteOneJson, origin: string): Page[] {
  const seo = new Map<string, { title: string; description: string; h1: string; robotsIndex: string | null }>();
  for (const row of siteone.tables?.seo?.rows ?? []) {
    const path = normalizePath(stringOrNull(row.urlPathAndQuery));
    if (!path) continue;
    seo.set(path, {
      title: stringOrEmpty(row.title),
      description: stringOrEmpty(row.description),
      h1: stringOrEmpty(row.h1),
      robotsIndex: stringOrNull(row.robotsIndex),
    });
  }
  const pages: Page[] = [];
  for (const result of siteone.results ?? []) {
    const url = stringOrNull(result.url);
    if (!url || !isHttp(url)) continue;
    const path = pathOf(url);
    const meta = seo.get(path);
    pages.push({
      url,
      path,
      status: stringOrEmpty(result.status),
      title: meta?.title ?? "",
      description: meta?.description ?? "",
      h1: meta?.h1 ?? "",
      robotsIndex: meta?.robotsIndex ?? null,
    });
  }
  for (const [path, meta] of seo) {
    if (pages.some((page) => page.path === path)) continue;
    const url = absoluteUrl(path, origin);
    if (!url) continue;
    pages.push({
      url,
      path,
      status: "",
      title: meta.title,
      description: meta.description,
      h1: meta.h1,
      robotsIndex: meta.robotsIndex,
    });
  }
  return pages.sort((a, b) => a.url.localeCompare(b.url));
}

function isProductPath(path: string): boolean {
  return /\/(products?|items?|goods|catalog|catalogue)(\/|$)/i.test(path);
}

function isContactPath(path: string): boolean {
  return /\/(contact|contacts|inquiry|enquiry|rfq|quote|request-quote)(\/|$|\.)/i.test(path);
}

function isHttp(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://");
}

function originOf(input: string): string {
  return new URL(input).origin;
}

function hostOf(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function pathOf(input: string): string {
  try {
    return new URL(input).pathname || "/";
  } catch {
    return "/";
  }
}

function absoluteUrl(value: string | null, origin: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, origin).href;
  } catch {
    return null;
  }
}

function normalizePath(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return pathOf(value);
  return value.startsWith("/") ? value.split("?")[0] || "/" : `/${value.split("?")[0]}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}
