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

模型只使用 Qwen4-Max、Skill V0.3 和已验证的生成结构。地址只允许 `https://dashscope.aliyuncs.com/compatible-mode/v1` 或北京 `*.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。密钥用 `VFDIAG_QWEN_API_KEY`，不写入仓库。

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

```json
"pdf": { "producer": "VEYFRONT", "status": "PENDING_VEYFRONT_PRINT", "visual_system": "veyfront.report.v2.1" }
```

VEYFRONT 用自己的 V2.1 打印样式读取这份 JSON 生成 PDF。VF-DIAG 当前不返回 PDF 字节。这一步尚未联调，不能当成已经完成。

建议的后续接口由 VEYFRONT 实现：

```http
POST /api/diagnosis/{job_ref}/pdf
```

VEYFRONT 的服务端读取上面的商业报告，套用 V2.1 打印样式，返回 `application/pdf`。不要把 VF-DIAG 的任务引用放进公开营销链接。
