# VF-DIAG 商业报告数据契约 V1

这份契约给 VEYFRONT 开发客户报告页和 PDF 使用。它是 `vfdiag.website-diagnosis.v1` 之外的新增数据，不改变原有任务状态和 `/v1/jobs/:ref/report` 的字段含义。

视觉和打印仍由 VEYFRONT 的海外获客诊断报告 V2.1 负责。VF-DIAG 不提供另一套客户报告 HTML 或 PDF 模板。

## 任务怎么走完

一次诊断任务依次做三件事：扫描、商业分析、客户报告数据。客户关掉页面不会停掉后台任务。刷新后继续看 `GET /v1/jobs/:ref`。

| 阶段 | 任务状态 | 技术报告 | 商业报告 |
| --- | --- | --- | --- |
| 扫描中 | `running` | 409 | 409 `COMMERCIAL_PENDING` |
| 分析或编排中 | `summarizing` | 409 | 409 `COMMERCIAL_PENDING` |
| 两份都完成 | `complete` 或 `partial` | 200 | 200 |
| 扫描连上了，但模型未配置、超时、数量对不上或输出无效 | `complete` 或 `partial` | 200 | 409，错误码见下表 |
| 网站没连上 | `failed` `TARGET_UNREACHABLE` | 409 | 409 |
| 已取消 | `cancelled` | 409 | 409 |
| 过期 | 410 | 410 | 410 |

原有状态字段没有增加新的人工审核状态。分析包里的 `manual_review_needed` 只留在任务目录的 `analysis.json`，不会挡住客户报告，也不会出现在商业报告 JSON 里。

扫描墙钟仍是 180 秒。模型调用单独 1800 秒。模型超时只放弃商业报告，已经写好的技术报告仍会发布。

同一份扫描结果已经有校验通过的 `analysis.json` 时，重试报告阶段不会重新扫描，也不会再次调用模型。已经发出但没有留下有效分析的调用，重启后也不会再付一次费。

## 读取商业报告

```http
GET /v1/jobs/{job_ref}/commercial-report
Authorization: Bearer <VFDIAG_SERVICE_TOKEN>
```

成功时正文是 `contracts/vfdiag.commercial-report.v1.schema.json` 描述的对象。真实回放样本在 `contracts/examples/commercial-report.jjg-replay.json`。那是一份历史分析的离线回放，生产代码不把该网站的名称、行业或产品写死。

失败时仍是原来的错误形状：

```json
{ "error": { "code": "COMMERCIAL_NOT_CONFIGURED", "message": "模型未配置，技术报告已保留，商业报告未生成。" } }
```

| code | 含义 |
| --- | --- |
| `COMMERCIAL_PENDING` | 任务还在扫描或分析 |
| `COMMERCIAL_NOT_CONFIGURED` | 没有配置 `VFDIAG_QWEN_API_KEY` |
| `COMMERCIAL_NOT_READY` | 任务结束了，但没有商业报告 |
| `MODEL_TIMEOUT` | 模型超时 |
| `MODEL_HTTP` | 模型接口不是 200 |
| `MODEL_INCOMPLETE` | 模型没有以 stop 结束 |
| `MODEL_OUTPUT` | 模型没有返回 JSON 对象 |
| `MODEL_INTERRUPTED` | 调用已经发出，但没有留下可用分析；不会自动再付费 |
| `MODEL_FAILED` | 其他模型失败 |
| `SOURCE_MISMATCH` | 分析里的域名或 200/301 数量和本次扫描不一致 |
| `ANALYSIS_INVALID` | 分析结构不能用 |
| `MODEL_NOT_AUTHORIZED` | 这次授权只覆盖公开页面扫描，没有同意模型处理 |
| `COMMERCIAL_SYNTHETIC` | 合成测试不调用付费模型 |
| `REVISION_MISMATCH` | 请求的报告版本和已发布版本不一致 |
| `CANCELLED` | 任务已取消，商业报告和 PDF 不交付 |

模型只使用 Qwen4-Max、Skill V0.3 和已验证的生成结构。地址只允许 `https://dashscope.aliyuncs.com/compatible-mode/v1` 或北京 `*.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。密钥用 `VFDIAG_QWEN_API_KEY`，不写入仓库。

2026-11-22 的扫描授权仍然可以创建扫描任务，但不能启动模型。模型处理使用与 VF 相同的一次授权：版本 `2026-11-26-growth-candidate`，文本哈希是该授权声明的 SHA-256。合成任务即使带上这条授权，也不会调用模型。

`GET /v1/jobs/:ref` 在原有状态上增加这些字段，不新增任务状态：

| 字段 | 含义 |
| --- | --- |
| `customer_report_available` | 在线商业报告是否已经发布 |
| `customer_report_reason` | 未发布时的原因码 |
| `customer_report_revision` | 已发布报告 JSON 的版本 |
| `commercial_contract_version` | 已发布时为 `vfdiag.commercial-report.v1` |
| `pdf_available` | PDF 是否已经保存 |
| `pdf_reason` | PDF 未完成时的原因，例如 `PDF_PENDING`、`PDF_NOT_CONFIGURED`、`PDF_RENDER_FAILED` |
| `synthetic` | 是否为合成测试任务 |

商业报告 JSON 同时带有 `job_ref`、`revision` 和 `synthetic`。`revision` 是报告 JSON 在 `revision` 为空时的 SHA-256。在线报告可以先交付，不必等 PDF。

模型输入优先使用已经验证过的 HTML 技术报告清理结果。HTML 里包含访问地址、标题、标题结构、404、跳转、电话、表单、图片替代文本或外链等表时，这些表会整表保留。没有这些表时，才退回扫描 JSON。评分刻度仍只从 HTML 图形读取。

## 客户报告里有什么

`sections` 对应 V2.1 的阅读顺序：

| 字段 | V2.1 段落 |
| --- | --- |
| `overview` | 总览、判断、已有资产、买家三步 |
| `chapters.discover` | 产品被找到、被看懂 |
| `chapters.convince` | 信任和已有营销资产 |
| `chapters.connect` | 询盘和联系 |
| `visuals` | 有来源编号的对照，不是新截图 |
| `next_step` | 咨询选择。`choices` 来自保留下来的发现，不是固定的某家企业方案 |
| `technical_appendix` | 技术评分附录。`is_business_score` 固定为 false |
| `evidence` | 可回查的事实、URL 和原始数字 |

`subject.limited` 为 true 时，只保留能对上来源的事实，结论从“系统性升级评估”收回到“先核实”，并且不给出升级选择。证据不足的发现会被丢掉，而不是交给人工补写。

`visuals[].asset_available` 为 false 时，没有可展示的页面截图。不要自行补图。

数字只来自分析里的来源概况和证据原始值。报告不新增流量、询盘、排名、收入或采购结果。

## PDF

商业报告里的 `delivery.pdf.status` 保持 `PENDING_VEYFRONT_PRINT`。这份标记不随 PDF 字节变化，因此不会改写 `revision`。

VF 持有唯一的 V2.1 打印页。该页返回同源 HTML，不返回 PDF 字节。VF-DIAG 在商业报告发布后读取这一页，再用容器里的 Chromium 按打印样式生成 PDF 并保存：

```http
GET {VFDIAG_PRINT_ORIGIN}/website-diagnosis/print
Authorization: Bearer <VFDIAG_RENDER_TOKEN>
X-VF-Job-Ref: {job_ref}
X-VF-Report-Revision: {revision}
Accept: text/html
```

打印地址必须是 HTTPS。本机联调可以是 `http://127.0.0.1` 或 `http://localhost`。凭据至少 32 位，并且和客户访问 VF-DIAG 的服务凭据分开。没有配置时，`pdf_reason` 为 `PDF_NOT_CONFIGURED`，在线报告仍然交付。

PDF 失败后可以单独重试，不重新扫描，也不再次调用模型：

```http
POST /v1/jobs/{job_ref}/pdf
GET /v1/jobs/{job_ref}/artifacts/pdf?revision={revision}
```

`revision` 不一致时返回 409 `REVISION_MISMATCH`。Worker 启动时如果发现 `pdf_reason` 为 `PDF_PENDING`，只补做这一次打印。
