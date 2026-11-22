# VF-DIAG — VEYFRONT Growth Diagnosis

**Status: DESIGN / ENGINEERING VALIDATION — NOT DEPLOYED.**  
**Owner:** VEYFRONT. **Implementation:** Cursor / approved contributors.  
**Repository:** https://github.com/gloweaseco-leo/VF-DIAG

## Mission

Make a manufacturing/B2B export website useful to **human overseas buyers, search engines, and AI-assisted procurement workflows**. Deliver a diagnosis that tells the customer what can be verified, what might hinder buyer tasks, what remains unknown, and which next actions are sensible.

**Customer value first, detection tooling second.** VF-DIAG is an independent open-source-tool assembly product, **not** a VRAE clone or a staging environment for VRAE. VRAE continues deep evidence-driven diagnostic development independently and is not a dependency or a production prerequisite.

## Buyer journey / growth tasks

- **Be found:** Search/SEO and AI-search/GEO readiness (not unverified ranking claims).
- **Be understood:** Product categories, specifications, applications, documents, languages.
- **Be trusted:** Public company identity, certifications as displayed (not verified as authentic), manufacturing evidence and consistency.
- **Be contacted:** Discoverability and usability of contact/RFQ entrypoints; no actual inquiry submission without explicit authorization.
- **Be usable internationally:** Mobile, performance, country-specific availability, language support.
- **Be usable by agents (later):** A browser/AI assistant's ability to locate public product facts and inquiry paths.
- **Be measurable (later):** Customer-authorized GSC/Bing Webmaster/analytics data, never inferred from crawling alone.

## Proposed OSS evaluation order (NOT YET ACCEPTED AS PRODUCTION)

1. [SiteOne Crawler](https://github.com/janreges/siteone-crawler) (MIT): primary candidate for safe, bounded site audit and native HTML/JSON report.
2. [Crawl4AI](https://github.com/unclecode/crawl4ai) (Apache-2.0): optional extraction adapter for public product/specification pages, only where SiteOne extraction proves insufficient.
3. [Unlighthouse](https://github.com/harlan-zw/unlighthouse) (MIT) / [Lighthouse](https://github.com/GoogleChrome/lighthouse) (Apache-2.0): optional laboratory performance audits, not presumed real-world customer experience.
4. [LibreCrawl](https://github.com/PhialsBasement/LibreCrawl) (MIT): alternative integrated app to benchmark before deciding whether to adopt a full application.

Use pinned releases, reproducible builds, license notices, and documented runtime limits. No blind dependency stacking.

## Boundaries

- **VF-DIAG:** independent job runner, OSS adapters, normalized evidence, bounded buyer-task analysis, reports.
- **VEYFRONT website:** public brand, customer experience, contact, sales intake. Integration later via versioned interface after separate review.
- **VRAE:** separate deep diagnosis R&D, not to be deployed or integrated by this project now.
- **L2M:** separate authorized site build/rebuild delivery, not triggered by diagnostic findings.

No shared database, no automatic sales lead on URL submission, no automatic merge/deploy to VEYFRONT.

## Claim standard

Each customer-facing statement must be classified as **OBSERVED**, **INFERRED**, **NEEDS_CONFIRMATION**, or **NOT_CHECKED**, with a source/URL, timestamp, scan scope, tool version, and evidence when applicable. Absence from sampled pages is **not** absence from the company's actual capabilities. GEO readiness is **not** proof of inclusion, referral traffic, or conversion. No synthetic revenue loss or fake competitive ranking.

For Google AI search, dedicated llms.txt or AI-specific markup is not a requirement. Official guidance:
- https://developers.google.com/search/docs/appearance/ai-features
- https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
- https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports
- https://www.bing.com/webmasters/help/ai-performance-9f8e7d6c
- https://help.openai.com/en/articles/9237897-conducting-your-searches-on-search

## Safety gates before real external scans

Explicit website owner/authorized operator permission; controlled target/redirect validation; SSRF and DNS-rebinding guard; public-network-only bounds; robots/access policy; rate/concurrency/time/page limits; browser-network isolation; log redaction and secure artifact retention. No load test, clone, password wall bypass, contact form submission, or actual commercial requests.

## Roadmap

**D0** source/license/safety and sample-site suitability test → **D1** reliable bounded scan + native report + JSON → **D2** buyer-task findings and GEO readiness → **D3** VEYFRONT customer-facing report experience → **D4** verified customer pilot, business acceptance and independent release decision.

See the repository Issues for actionable Cursor work packages. All customer examples must be derived from real authorized scans or explicitly marked synthetic. Never claim production readiness until verified.

---
2026-11-22 · VEYFRONT Owner decision · No implementation or public deployment yet.
