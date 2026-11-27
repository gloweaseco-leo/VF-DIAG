# VF-DIAG × VEYFRONT｜SiteOne MVP 界面、接口与联调实施方案 V1.0

**Owner裁决｜2026-11-22。状态：正式开发设计基线，未开发、未联调、未发布。**

**唯一权威来源：本文件在 VF-DIAG 仓库。** VEYFRONT 的开发 Issue 只引用它，不复制变体契约。与 [VF-DIAG MVP产品验收V1.1](MVP_PRODUCT_ACCEPTANCE_V1_0.md)、[客户报告UI V1.1](MVP_CUSTOMER_REPORT_UI_V1_0.md)配套。冲突时：客户价值/取证规则以这两份为准，**跨仓边界/接口/联调/发布以本文为准**。

## 1. Owner 已定方向与排除项

**一个 VEYFRONT 客户入口 + VF-DIAG 独立任务/事实服务 + SiteOne 唯一初始扫描引擎。**

- **复用 PR #36/#37 的客户设计资产；不直接合并 PR #37，也不基于它的老分支继续大范围开发。** VEYFRONT 最新 main 建新开发分支，选择性移植界面。已核实 #37 是未合并 Draft、以 #36 预览分支为 base；主站 main 还没有 /website-diagnosis。
- **SiteOne 的原生 HTML/JSON 是专业明细；客户看到的是 VEYFRONT 统一品牌的有据诊断报告。** 不用 SiteOne 原生界面取代官网，不为它重建技术仪表盘。
- **M0 固定 SiteOne v2.5.1 试跑。** 该tag有 HTML/JSON、Markdown、Chromium/截图、可选 AI summary/custom prompt；新main文档所列 AI extract/geo/事件流及stdin控制不当作已验收能力。M1版本升级必须另行固定SHA/回归和Owner批准。
- VRAE 与此 MVP **互不依赖**，不沿用 #37 的 VRAE会话/mTLS/Bearer、报告Authority、签名/数据契约；VRAE原PR保留以供将来独立专业诊断使用。
- 首期不做56项、采购Agent、全文档OCR、CRM、新商业报价或真实表单提交。**但MVP必须完整具备任务、会话、报告、访问、安全、咨询、失败恢复和可追责运营能力。**

## 2. 仓库责任和运行边界

| 模块 | 唯一责任方 | 交付边界 |
| --- | --- | --- |
| 诊断入口、语言、品牌、手机端、可访问交互 | **VEYFRONT** | `/website-diagnosis` 中文默认、`/en/website-diagnosis` 英文；入口来自首页“已有旧站”和Rebuild咨询页 |
| 服务端BFF、Cookie会话、用户授权记录入口、公共速率限制、对客户API与商业触点 | **VEYFRONT** | 浏览器仅访问VEYFRONT同源API；不暴露 VF-DIAG 内网origin/服务凭据 |
| 任务生命周期、站点授权范围核验、目标和子资源网络隔离、限额、取消/强杀 | **VF-DIAG** | 独立有界Worker；不运行在Vercel普通页面请求中 |
| SiteOne原始工件/页面事实/业务映射/可发布报告JSON | **VF-DIAG** | 保留原始证据与来源，不对SiteOne技术分数做销售决策 |
| 中文/英文客户报告UI、证据卡、技术报告授权展示、打印 | **VEYFRONT** | 只展示已验证的报告投影，不自己重判网站缺陷 |
| Rebuild项目表单、企业微信、实际线索 | **VEYFRONT现有设施** | 网址提交或查看报告不等于销售线索，只有客户主动咨询才进入已有渠道 |
| 专业工业采购深度诊断 | **VRAE（独立）** | 本轮不接、不共享数据库，不自动把SiteOne finding升级为VRAE finding |

**部署决策原则：** VEYFRONT=现有 Vercel Next/短请求；VF-DIAG=可稳定运行的独立Worker和受控持久化（M0可在受限本地环境验证），服务端互通走固定origin+独立身份（受控网络或HTTPS绑定鉴权）；不复用VRAE的密钥、PG、Worker或受信会话。当前给 Vercel Preview 的受控入口是本机 Tailscale Funnel：HTTPS 转到 `127.0.0.1:8787`，不把 8787 公布到局域网。本机 443 和 8443 已被其他服务占用，VF-DIAG 使用 Funnel 端口 10000。凭据是独立的 `VFDIAG_SERVICE_TOKEN`，只放在 gitignore 的 `.env` 和 Vercel Preview 环境变量里。回执见 `contracts/examples/i2-funnel-receipt.json`。M0 Worker 只在本地 Docker 里运行，见仓库 `Dockerfile`、`docker-compose.yml` 与 `docker-compose.funnel.yml`。

## 3. PR #36/#37 选择性复用明细

| 来源文件（PR #37；部分源自 #36） | 取舍 | 落地要求 |
| --- | --- | --- |
| `app/website-diagnosis/page.tsx`、`components/veyfront/diagnosis/preview.tsx` | **保留设计/布局与文案框架** | 替换“示例、VRAE preview”运营分支为 SiteOne真实任务；保留一次授权与中文优先；不能把演示步进当进度 |
| `components/veyfront/diagnosis/connected-preview-form.tsx` | **仅复用交互与状态展示** | 改用独立VF-DIAG客户端适配；移除VRAE邀请、静态/动态会话与多余预览流程 |
| `app/website-diagnosis/report/page.tsx`、`customer-report.tsx`、`customer-report-details.tsx`、`customer-judgment.tsx`、打印样式 | **重点复用视觉与证据组件** | 首屏压缩为发现/产品/联系三项；VRAE五任务/走通连续路径只在有同等级证据时展示，不能靠URL发现冒充买家走通 |
| `customer-report-model.ts`、`lib/vrae-preview-client.ts`、`lib/vrae-consumer/*` | **不复用VRAE数据投影合同** | 对接 `vfdiag.website-diagnosis.v1` 的独立轻量客户报告类型 |
| `app/api/website-diagnosis/v1/route.ts`、`lib/vrae-preview.ts`、`lib/vrae-g1-*` | **不复制到SiteOne服务** | 另建同源、版本化VF-DIAG BFF路由；VRAE旧实现只留在原PR |
| `proxy.ts`、`app/sitemap.ts`、首页Hero、Rebuild页面及移动导航 | **以当下VEYFRONT main为主** | 按现在的中文无前缀/英文`/en`、移动布局与SEO规则小范围集成，不倒退PR #38等main最新内容 |

**请勿把 #37 的40个文件整体 cherry-pick 或误判 Preview READY=真实SiteOne联调PASS。** 复用组件时检查依赖和样例数据；可按文件或片段移植，避免隐藏引入VRAE SDK和运营令牌。

## 4. 路由与授权（MVP必须可用）

### VEYFRONT页面
- `/website-diagnosis` / `/en/website-diagnosis`：公开介绍、网址输入、一次显式授权、任务状态及取消。**尚未上线前继续隐藏/受控预览**。
- `/website-diagnosis/report` / `/en/website-diagnosis/report`：登录非必需的客户报告；服务端授权后读取，只返回获准数据。具体`job_ref`仅为定位，**不是访问凭证**。报告、工件永不进入站点sitemap，返回 `noindex,nofollow`、`no-store`、`no-referrer`。
- 发布时将公开**诊断介绍页**加入VEYFRONT canonical/hreflang/sitemap；私有报告页始终不收录。沿用main中文默认、英文`/en`；诊断不会重构官网导航，不增加移动底栏常驻第五项。

### 顾客会话
- 用户提交HTTPS网址+授权版本、文本哈希、确认时间；**明确“用户声明授权”，不宣称经DNS或官方证明站点所有权**；服务器重新验证真实目标和范围。
- 允许匿名、同浏览器的受保护 HttpOnly+Secure+SameSite 会话返回任务和报告；状态回读及取消必须校验会话主体。浏览器重开/刷新在有效期内应能恢复；若过期给出明确重试说明。跨设备分享/一次性恢复码不是M1必备，**在有授权签发与撤销方案前不得分享公开报告直链**。
- 用户同意包括只读公开采集和**若实际使用模型时**的数据处理、第三方模型提供方及数据范围。M0可不启用模型；不能因 SiteOne 提供AI按钮就自动调用付费模型。
- 结果链接、Analytics/日志不能包含授权令牌、原始页面正文、完整请求参数或客户身份信息。

## 5. 两仓最小接口契约（字段已固定，本地 Docker 骨架已可运行，尚未联调上线）

统一版本：`vfdiag.website-diagnosis.v1`，后端明确 `engine=siteone`、`engine_version`、`report_schema_version`。**客户浏览器永不直接请求VF-DIAG。**

### VEYFRONT 同源 BFF（建议固定以下路由，避免与 #37 VRAE 的 /api/website-diagnosis/v1 冲突）

| 方法及路径 | 用途 | 响应 |
| --- | --- | --- |
| `POST /api/website-diagnosis/siteone` | 网址+一次同意、创建/复用任务 | `202` + `job_ref`/状态/轮询建议；非法或未授权不创建任务 |
| `GET /api/website-diagnosis/siteone/{job_ref}` | 当前会话查看实时状态 | `200`；其他会话不得读取 |
| `POST /api/website-diagnosis/siteone/{job_ref}/cancel` | 取消任务 | `202/200`；不可取消终态幂等返回 |
| `GET /api/website-diagnosis/siteone/{job_ref}/report` | 当前会话读取结构化客户报告 | `200`；未就绪明确状态，不能返回演示内容 |
| `GET /api/website-diagnosis/siteone/{job_ref}/artifacts/{kind}` | 只读获取允许的原生工件 | `200` 安全附件/隔离视图；禁止任意路径参数 |

BFF必须执行同源/CSRF、用户会话、最小频率限制、脱敏错误映射及禁缓存。成功回读/失败处理不可依赖浏览器带的后端origin、任意文件路径、服务token。

### VF-DIAG 内部服务
与 BFF 一一对应的最小 `POST/GET /v1/jobs`、`POST /v1/jobs/{job_ref}/cancel`、`GET /v1/jobs/{job_ref}/report`、`GET /v1/jobs/{job_ref}/artifacts/{kind}`。浏览器不调用这些路由。调用方带 `Authorization: Bearer`，令牌只放在 VEYFRONT 服务端。kind 只允许 `html` 和 `json`，响应是附件，不在页面里执行 HTML。

**创建请求字段**：`contract_version=vfdiag.website-diagnosis.v1`、`url`、`language=zh|en`、`authorization={version:2026-11-22, accepted:true, accepted_at, text_hash}`、`idempotency_key`。`text_hash` 是授权声明原文的 SHA-256。`language=en` 可以提交，但 `report_language` 固定为 `zh`。同一幂等键加同一请求返回已有任务；同一幂等键换了网址，或换了浏览器标识，返回 `409 IDEMPOTENCY_CONFLICT`，响应里没有任务编号。M0 同时只接受一个未结束任务，多余请求返回 `429 JOB_CAPACITY`。

付费诊断（增长授权，且不是合成主机）还必须带 `X-VF-Admission-Day`（上海日期 `YYYY-MM-DD`）、`X-VF-Admission-Browser` 和 `X-VF-Admission-IP`（各 64 位小写十六进制，按日脱敏）。只去掉 `www` 或改页面路径视为同一网站，其他子域名分开计算。同一网站 7 天内已完成一次商业诊断返回 `409 SITE_RECENTLY_DIAGNOSED`；正在诊断返回 `409 SITE_DIAGNOSIS_IN_PROGRESS`。这些拒绝不返回已有任务编号或报告。同一浏览器每天一个新网站，返回 `429 BROWSER_DAILY_LIMIT`。同一网络标识每天最多 5 个新任务，返回 `429 IP_DAILY_LIMIT`。当日模型费用达到 6 元后不再接受新的付费诊断，返回 `429 DAILY_BUDGET_LIMIT`；达到 5 元只记预警。已有报告和 PDF 仍可读取。失败、取消或重启后的重试不第二次调用模型。缺少或过期的准入头返回 `400 ADMISSION_REQUIRED`。只扫描授权和合成任务不走这套限额。

**任务状态**：`queued | validating | running | summarizing | complete | partial | failed | cancelled | expired`。状态体包含 `job_ref,state,updated_at,expires_at,scope,checked_pages,remaining_unknown,reason_code,reason,poll_after_seconds,report_available,target_host,synthetic,report_language`。`remaining_unknown` 在 M0 恒为 true，不返回百分比。工件和报告保留 7 天。到期后读取返回 `410`，并删除该任务目录里的 `siteone.html`、`siteone.json`、`report.json`；`job.json` 只留下过期状态。Worker 重启时也会清掉已到期任务的这三份工件。

**客户报告以 [contracts/vfdiag.website-diagnosis.v1.schema.json](../contracts/vfdiag.website-diagnosis.v1.schema.json) 为准。** VEYFRONT 按这个投影渲染，不读取 SiteOne 原始 JSON 再判断缺陷。投影包含优势、三张买家任务卡、产品观察、联系观察、语言观察、联系方式类型、最多三条优先事项、分叉和可复制口述。技术分、缺 H1 或单个 404 不会输出 `DISCUSS_REBUILD` 或 `SELF_FIX`。无证据时优先事项可以为 0 条。

合成样本在 `contracts/examples/`，都不是已授权客户实测：

| 文件 | 结果 |
| --- | --- |
| `synthetic-local-optimize.report.json` | 一次真实合成扫描。产品页和联系页返回 200，另有一条已证实 404。下一步是先修这一处。 |
| `synthetic-keep.report.json` | 产品页和联系页都返回 200，缺 H1、技术分为 0 也不改变结论。下一步是保持现站。 |
| `synthetic-confirm-first.report.json` | 只打开了首页，产品和联系都未核实。下一步是先看本次范围，不能当成网站缺陷。 |
| `synthetic-special-upgrade.report.json` | 产品路径和联系路径都有已证实 404。下一步是讨论升级，不是重建。 |
| `synthetic-engine-failed.status.json` | 扫描没有留下 JSON。任务失败，不发布客户报告。 |

稳定错误码包括：`TARGET_URL_INVALID`、`TARGET_SCHEME_REJECTED`、`TARGET_HOST_REJECTED`、`TARGET_PRIVATE_ADDRESS`、`TARGET_DNS_FAILED`、`TARGET_PORT_REJECTED`、`AUTHORIZATION_REQUIRED`、`AUTHORIZATION_TEXT_MISMATCH`、`IDEMPOTENCY_CONFLICT`、`JOB_CAPACITY`、`JOB_NOT_FOUND`、`REPORT_NOT_READY`、`ARTIFACT_NOT_FOUND`、`ENGINE_BINARY_MISSING`、`ENGINE_VERSION_MISMATCH`、`ENGINE_TIMEOUT`、`ENGINE_FAILED`、`UNSAFE_OFFHOST`、`WORKER_RESTARTED`、`EXPIRED`、`ADMISSION_REQUIRED`、`SITE_RECENTLY_DIAGNOSED`、`SITE_DIAGNOSIS_IN_PROGRESS`、`BROWSER_DAILY_LIMIT`、`IP_DAILY_LIMIT`、`DAILY_BUDGET_LIMIT`。

**契约约束**：BFF 只消费上述投影。未知 `report_schema_version` 关闭报告展示。扫描完成但产品或联系仍未核实的，任务可以是 `complete`，报告 `headline.status` 为 `partial`。

## 6. 原生HTML、客户隐私、运营与咨询

- SiteOne 原生 HTML 是来自不可信站点与扫描器的第三方内容：**不能同源直接以可执行HTML嵌入 VEYFRONT**。M1最低要求提供经鉴权的`Content-Disposition: attachment`安全下载；若提供在线交互式查看，须使用隔离来源、限制脚本/CSP与严格跨域保护，单独验收。
- 后端禁止扫描云内网、私网、重绑定、非预期跳转和浏览器子资源网络越界；禁止SMTP、镜像、压测、表单提交及无授权主动外发。按MVP文档限制速率、并发、文件大小、总耗时、工具进程树并可靠取消/超时。
- **任务与报表最小运营台账**：申请/受理/开始/结束时间、引擎版本、任务状态、失败原因、扫描范围、资源与AI费用（如使用）、报告过期时间、清理结果、匿名阅读/点击事件；有排队上限、Worker离线恢复和日志脱敏；不建CRM。
- 官网已核实的咨询端点：`/start/rebuild`、`/contact#wechat`、`/contact#project-form`。**不要复用PR#37旧链接`/start/rebuild#rebuild-inquiry`**，目前main没有验证到这个锚点。
- 当前Rebuild表单 `LeadForm` 已支持 `sessionStorage["vf:rebuild-url"]` 读取一次并清理：可以在客户主动点击后安全预填公开网站URL；**不得把私有报告token/ref、扫描文本或客户原始证据塞进营销URL**。咨询仍由用户主动提交，报告阅读或企业微信二维码点击≠有效线索。
- 最小统计：`report_viewed`、`rebuild_link_clicked`、`wecom_link_clicked`（计数/匿名来源）；PR#37中的`DiagnosisPreviewTelemetry`直接排除诊断页面的Vercel Analytics，不能原样照搬后又宣称已统计转化。统计仅上传无隐私的事件类别和已批准的匿名指标。
- 发布前复核诊断授权/数据处理的隐私与条款表达、客户删除/过期机制、第三方模型调用披露；人工服务费用与报告结果不得自动绑定“购买重建”。

## 7. 联调、验收及发布（两个Cursor可以并行）

| 关口 | VF-DIAG Cursor | VEYFRONT Cursor | 不可替代的验收 |
| --- | --- | --- | --- |
| I0 合同 | 固定schema、状态、错误码、工件授权合同；合成夹具 | 从**最新main**开新分支；复用#36/#37的具体UI、使用同一schema适配 | 同一合同双侧契约测试；无VRAE代码/密钥混入 |
| I1 独立运行 | M0实跑SiteOne v2.5.1原生HTML/JSON及安全PASS | 输入/授权、三买家问题卡、证据/部分完成/错误/打印及咨询入口（明确合成态） | 浏览器双语/手机/无虚假报告；SiteOne进程可终止 |
| I2 真实Vercel联调 | 受控可达服务、限额及可复核报告；提供服务端凭据私下交接 | Vercel Preview BFF真实建单→轮询→取消→报告→原生工件→自愿咨询 | 实际Vercel请求+VF-DIAG Worker+SiteOne同任务证据链；拒绝态403/429/503、超时和过期；不能用mock当实连 |
| I3 客户业务GO | 已授权制造业站点，产品页和联系入口均有可回查事实 | 客户报告中能读懂一个问题或明确无须重建；重要CTA/手机端验证 | Owner独立GO/FIX/NO-GO，之后才决定接入`veyfront.com`正式入口 |

- 业务正反样本至少包含：产品/联系路径已证实问题、表现正常无需重建、采集受阻或失败。**每个结论引用原始证据**；技术分/单点404/缺H1不得直接触发Rebuild。
- 运营测量：真实报告阅读和咨询按钮意向分开；没有人工核实不得声称形成商机或成交。
- 发布前做 VEYFRONT 既有首页、Rebuild、Launch、价格、FAQ、联系方式、企业微信、SEO、移动端导航回归；正式生产按Owner单独批准的分支/部署进行。
- **真实联调取证**：两个仓库HEAD、工具版本/二进制校验、配置脱敏摘要、Vercel deployment ID、服务端task_ref、原生HTML/JSON、报告JSON、正常/失败/取消/过期、3种样例和手机截图。所有“未运行”保持 NOT_TESTED，禁止声明PASS。

## 8. Cursor分工与禁止扩大范围

- **[VF-DIAG Issue #2](https://github.com/gloweaseco-leo/VF-DIAG/issues/2)**：承担M0/M1 SiteOne Worker、内部任务/报告API、证据映射、保护与工件。对本合同出一个Draft PR，不改VEYFRONT。
- **[VEYFRONT Issue #39](https://github.com/gloweaseco-leo/VEYFRONT/issues/39)**：承担从main选择性复用PR#36/#37 UI、同源BFF、客户会话与访问、报告/证据、原有咨询路径、SEO与移动端回归。对本合同出一个Draft PR，不合并/关闭#37。
- 两边可以各自用受控合成Fixture开发，但**联调GO必须基于真实服务和已授权网站**；不得因为缺签发/授权材料而把某次合成测试称作真实客户验收。
- **不新增**独立前端仓库、共享生产数据库、完整多引擎诊断平台、VRAE兼容层、CRM、复杂账号系统、虚假进度或自动销售转化。

**Owner验收句：VEYFRONT客户在同一品牌旅程中输入网址并授权，真实调用独立SiteOne Worker，看到可回查的产品/联系观察与合理改善建议，再自主选择是否咨询。**

## 9. 商业报告数据（2026-11-26 增补）

扫描之后，VF-DIAG 可以用 Qwen4-Max 和 Skill V0.3 生成第二份数据：`GET /v1/jobs/:ref/commercial-report`。任务状态上补充 `customer_report_available`、`customer_report_reason`、`customer_report_revision`、`commercial_contract_version`、`pdf_available` 和 `pdf_reason`。PDF 由 VF-DIAG 向 VF 的 `/website-diagnosis/print` 请求后保存，失败时 `POST /v1/jobs/:ref/pdf` 单独重试。字段和授权见 [商业报告数据契约 V1](VF_DIAG_COMMERCIAL_REPORT_V1.md)。原有 `/report` 技术投影不变。

PDF 仍由 VEYFRONT 用 V2.1 打印样式生成。VF-DIAG 只提供数据和 `pdf.status = PENDING_VEYFRONT_PRINT`。这一步还没有跨仓联调。
