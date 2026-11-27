import { projectReport } from "../../src/report/project.ts";
import type { SiteOneJson } from "../../src/report/types.ts";

const base = {
  synthetic: true,
  generatedAt: "2026-11-23T02:00:00.000Z",
  engineVersion: "2.5.1",
};

export function keepReport() {
  return projectReport({
    ...base,
    jobRef: "synthetic-keep",
    inputUrl: "https://factory.example/",
    host: "factory.example",
    siteone: keepSite(),
  });
}

export function confirmFirstReport() {
  return projectReport({
    ...base,
    jobRef: "synthetic-confirm",
    inputUrl: "https://factory.example/",
    host: "factory.example",
    siteone: thinSite(),
  });
}

export function specialUpgradeReport() {
  return projectReport({
    ...base,
    jobRef: "synthetic-upgrade",
    inputUrl: "https://factory.example/",
    host: "factory.example",
    siteone: bothBrokenSite(),
  });
}

function keepSite(): SiteOneJson {
  return {
    crawler: { version: "2.5.1", executedAt: "2026-11-23 02:00:00" },
    stats: { totalUrls: 2 },
    results: [
      { url: "https://factory.example/products/valve", status: "200", type: 1 },
      { url: "https://factory.example/contact", status: "200", type: 1 },
    ],
    tables: {
      seo: {
        rows: [
          {
            urlPathAndQuery: "/products/valve",
            title: "闸阀 Z41H",
            h1: "",
            description: "公称压力 1.6MPa。这是合成规格文字，不是真实产品。",
            robotsIndex: "1",
          },
          { urlPathAndQuery: "/contact", title: "联系合成样本", h1: "联系", description: "", robotsIndex: "1" },
        ],
      },
      "external-urls": { rows: [{ url: "mailto:sample@example.com" }] },
    },
    qualityScores: { overall: { score: 0, label: "F" } },
  };
}

function thinSite(): SiteOneJson {
  return {
    crawler: { version: "2.5.1", executedAt: "2026-11-23 02:00:00" },
    stats: { totalUrls: 1 },
    results: [{ url: "https://factory.example/", status: "200", type: 1 }],
    tables: {
      seo: { rows: [{ urlPathAndQuery: "/", title: "合成样本首页", h1: "", description: "只有首页，没有产品或联系入口。", robotsIndex: "1" }] },
    },
  };
}

function bothBrokenSite(): SiteOneJson {
  return {
    crawler: { version: "2.5.1", executedAt: "2026-11-23 02:00:00" },
    stats: { totalUrls: 3 },
    results: [
      { url: "https://factory.example/", status: "200", type: 1 },
      { url: "https://factory.example/products/valve", status: "404", type: 1 },
      { url: "https://factory.example/contact", status: "404", type: 1 },
    ],
    tables: {
      "404": {
        rows: [
          { url: "https://factory.example/products/valve", sourceUqId: "/", statusCode: "404" },
          { url: "https://factory.example/contact", sourceUqId: "/", statusCode: "404" },
        ],
      },
      seo: { rows: [{ urlPathAndQuery: "/", title: "合成样本首页", h1: "首页", description: "产品和联系链接都失效。", robotsIndex: "1" }] },
    },
  };
}
