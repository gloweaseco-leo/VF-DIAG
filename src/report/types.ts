export type ClaimLevel = "OBSERVED" | "INFERRED" | "NEEDS_CONFIRMATION" | "NOT_CHECKED";

export type NextStep =
  | "KEEP"
  | "SELF_FIX"
  | "LOCAL_OPTIMIZE"
  | "SPECIAL_UPGRADE"
  | "DISCUSS_REBUILD"
  | "CONFIRM_FIRST";

export type SourceRef = {
  source_url: string | null;
  target_url: string | null;
  source_field: string;
  excerpt: string | null;
  observed_at: string | null;
  observed_at_has_timezone: false;
  scope: string;
};

export type BuyerTask = {
  question: string;
  status: ClaimLevel;
  fact: string;
  impact: string;
  impact_level: "INFERRED" | "NOT_CHECKED";
  suggestion: string;
  source: SourceRef;
};

export type Priority = {
  id: string;
  title: string;
  claim_level: "OBSERVED";
  fact: string;
  impact: string;
  impact_level: "INFERRED";
  suggestion: string;
  needs_confirmation: string;
  buyer_step: "find" | "understand" | "contact";
  source: SourceRef;
};

export type Advantage = {
  id: string;
  title: string;
  claim_level: "OBSERVED";
  fact: string;
  source: SourceRef;
};

export type CustomerReport = {
  contract_version: "vfdiag.website-diagnosis.v1";
  report_schema_version: "1.0";
  report_language: "zh";
  synthetic: boolean;
  job_ref: string;
  engine: "siteone";
  engine_version: string;
  target: { input_url: string; host: string };
  generated_at: string;
  timezone: "Asia/Shanghai";
  retention_days: 7;
  headline: {
    domain: string;
    scanned_at: string | null;
    status: "complete" | "partial";
    summary: string;
  };
  ai_visibility: { status: "NOT_CHECKED"; statement: string };
  coverage: {
    scanned_pages: number;
    max_urls: number;
    max_depth: number;
    partial: boolean;
    reason_codes: string[];
    statement: string;
  };
  advantages: Advantage[];
  buyer_tasks: { find: BuyerTask; understand: BuyerTask; contact: BuyerTask };
  product_observation: {
    status: ClaimLevel;
    url: string | null;
    title: string | null;
    excerpt: string | null;
    http_status: string | null;
    specs_status: ClaimLevel;
    specs_note: string;
    source: SourceRef;
  };
  contact_observation: {
    status: ClaimLevel;
    url: string | null;
    title: string | null;
    http_status: string | null;
    source: SourceRef;
  };
  language_observation: {
    status: ClaimLevel;
    sampled_pages: number;
    cjk_chars: number;
    latin_letters: number;
    fact: string;
    inference: string;
    inference_level: "INFERRED" | "NOT_CHECKED";
    source: SourceRef;
  };
  contact_channel_observation: {
    status: ClaimLevel;
    channels: Array<{ type: "email" | "phone" | "whatsapp" | "wechat"; url: string }>;
    statement: string;
    source: SourceRef;
  };
  priorities: Priority[];
  recommended_next_step: NextStep;
  next_step_reason: string;
  primary_action: { label: string; kind: "evidence" | "artifact" | "coverage" | "rebuild" };
  share_blurb: string;
  artifact_kinds: Array<"html" | "json">;
};

export type SiteOneTable = { rows?: Array<Record<string, unknown>> };

export type SiteOneJson = {
  crawler?: { version?: unknown; executedAt?: unknown };
  options?: { url?: unknown };
  stats?: { totalUrls?: unknown };
  results?: Array<{ url?: unknown; status?: unknown; type?: unknown }>;
  tables?: Record<string, SiteOneTable | undefined>;
  qualityScores?: unknown;
};
