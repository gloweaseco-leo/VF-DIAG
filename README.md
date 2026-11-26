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

## Approved MVP: SiteOne-first

**MVP implementation is limited to one SiteOne Crawler engine and a thin VF-DIAG job/report interface. M0 uses pinned v2.5.1; M1 may change only to a separately verified, pinned SiteOne version with Owner approval.** Do not build a multi-framework product for the initial customer trial.

- Real input: HTTPS URL + one explicit authorization attestation.
- Real output: bounded SiteOne scan, native HTML + JSON, Chinese mobile-first summary **including an evidenced sample product-page observation and a contact-entry observation (or an explicit unverified status)**, evidence-linked next steps, optional user-initiated VEYFRONT consultation.
- Real limits: no fake progress, no guaranteed search/AI referrals, no unverified negative claims or fabricated conversions; SiteOne quality score is technical, **not a rebuild verdict**.
- Source/version warning: v2.5.1 tag documents HTML/JSON, browser screenshots and optional AI technical summary. Newer main-branch-only features such as AI extraction/IA/GEO report flags and NDJSON/stdin controls are **not MVP dependencies** unless independently verified and version-pinned.
- Future framework research is retained as historical context, **not an implementation instruction**. Add another engine only after a documented MVP customer-value gap and separate Owner decision.

**Cursor must follow two current executable documents:** [MVP Product & Acceptance V1.1](docs/MVP_PRODUCT_ACCEPTANCE_V1_0.md) and [MVP Customer Report & UX V1.1](docs/MVP_CUSTOMER_REPORT_UI_V1_0.md).

**Cross-repository implementation contract:** [VF-DIAG × VEYFRONT SiteOne MVP integration V1.0](docs/VF_DIAG_X_VEYFRONT_MVP_INTEGRATION_V1_0.md). [VF-DIAG Issue #2](https://github.com/gloweaseco-leo/VF-DIAG/issues/2) implements Worker/job/report/evidence API; [VEYFRONT Issue #39](https://github.com/gloweaseco-leo/VEYFRONT/issues/39) implements the customer UI/BFF/commercial path. Reuse the UI assets in VEYFRONT PR #36/#37 selectively from its latest main, not the VRAE backend contract. [Product Strategy V1.1](docs/PRODUCT_STRATEGY_V1_1.md) remains the long-term business context, not a requirement to implement all 56 indicators in MVP.

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

**M0** synthetic safety baseline + real SiteOne v2.5.1 HTML/JSON → **M1** authorized URL + one product and one contact observation + Chinese evidence-based report + voluntary consultation → **M2** only after real feedback: deeper multi-page product extraction/screenshot improvements. Broader D0–D4 / 56-indicator platform roadmap is deferred, not a blocker for MVP.

See the repository Issues for actionable Cursor work packages. All customer examples must be derived from real authorized scans or explicitly marked synthetic. Never claim production readiness until verified.

## Local worker

M0 runs in local Docker, not as a bare process on the developer machine. The image pins SiteOne Crawler v2.5.1 (MIT) by tarball SHA-256. The API listens inside the container and is published only on `127.0.0.1:8787`.

```bash
docker compose up --build
```

Synthetic crawl, including the local fixture site:

```bash
docker compose -f docker-compose.yml -f docker-compose.synthetic.yml up --build
docker compose -f docker-compose.yml -f docker-compose.synthetic.yml exec worker node src/m0-check.ts
npm run local-bff
```

`npm run local-bff` calls the published `127.0.0.1:8787` from the host. It checks auth rejection, a private target, one-at-a-time capacity, a synthetic scan, report and attachment downloads, idempotency, and cancel. It does not scan a real site.

The default worker rejects private and loopback targets. `fixture-site` is allowed only when `docker-compose.synthetic.yml` sets `VFDIAG_SYNTHETIC_HOSTS`. Customer reports follow `contracts/vfdiag.website-diagnosis.v1.schema.json`. The commercial report is a separate document, `GET /v1/jobs/:ref/commercial-report`, described in `docs/VF_DIAG_COMMERCIAL_REPORT_V1.md`. It is produced only when `VFDIAG_QWEN_API_KEY` is set. The key is not stored in the repo. Unit tests do not need Docker: `npm test`.

The compose placeholder token is accepted only with `VFDIAG_LOCAL_ONLY=1`. That flag does not open or close ports; the published address stays `127.0.0.1:8787`. Seven days after a job is created, the worker deletes `siteone.html`, `siteone.json` and `report.json`. A local test pass is not a customer GO.

Vercel Preview is not on the tailnet, so the remote path is Tailscale Funnel rather than tailnet-only Serve. Funnel terminates HTTPS and proxies to `127.0.0.1:8787`. Port 8787 stays unpublished on the LAN. On this machine ports 443 and 8443 are already in use, so VF-DIAG uses Funnel port 10000:

```bash
npm run issue-token
docker compose -f docker-compose.yml -f docker-compose.synthetic.yml -f docker-compose.funnel.yml up --build -d
tailscale funnel --bg --https=10000 http://127.0.0.1:8787
```

`npm run issue-token` writes a 32-byte random `VFDIAG_SERVICE_TOKEN` into gitignored `.env` and does not print it. Put that same variable on the Vercel Preview project. It is not a VRAE key. `VFDIAG_FUNNEL=1` refuses the placeholder and caps one caller at 180 requests a minute, which covers one diagnosis polled every two seconds. The funnel overlay also turns on container egress filtering: private, loopback, link-local, metadata and CGNAT destinations are rejected, while Docker DNS and the pinned `172.16.50.0/24` fixture subnet stay reachable. `npm run i2-check` records the public health check, auth rejection, synthetic diagnosis, redirect, subresource, egress, timeout and restart evidence without writing the token.

---
2026-11-22 · VEYFRONT Owner decision · No implementation or public deployment yet.
