import { lookup } from "node:dns/promises";
import path from "node:path";
import { assertServiceToken } from "./http/request.ts";
import { createHttpServer } from "./http/server.ts";
import { fetchPrintPdf } from "./commercial/pdf.ts";
import { createProductionAnalyzer } from "./commercial/qwen.ts";
import { createJobService } from "./jobs/service.ts";
import { runSiteOne } from "./siteone/run.ts";

const funnel = process.env.VFDIAG_FUNNEL === "1";
const token = assertServiceToken(process.env.VFDIAG_SERVICE_TOKEN, {
  localOnly: process.env.VFDIAG_LOCAL_ONLY === "1",
  funnel,
});
const port = Number(process.env.VFDIAG_PORT ?? 8787);
const bind = process.env.VFDIAG_BIND ?? "127.0.0.1";
const dataDir = process.env.VFDIAG_DATA_DIR ?? path.join(process.cwd(), "data");
const siteoneBin = process.env.SITEONE_BIN ?? "siteone-crawler";
const syntheticHosts = new Set(
  (process.env.VFDIAG_SYNTHETIC_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);

const qwenKey = process.env.VFDIAG_QWEN_API_KEY;
const printOrigin = process.env.VFDIAG_PRINT_ORIGIN;
const renderToken = process.env.VFDIAG_RENDER_TOKEN;
const jobs = createJobService({
  dataDir,
  syntheticHosts,
  lookup: async (hostname) => {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  },
  run: (options) => runSiteOne({ ...options, bin: siteoneBin }),
  analyze: qwenKey ? createProductionAnalyzer({ apiKey: qwenKey, baseUrl: process.env.VFDIAG_QWEN_BASE_URL }) : undefined,
  renderPdf: printOrigin && renderToken && renderToken.length >= 32
    ? (input) => fetchPrintPdf({ ...input, origin: printOrigin, token: renderToken })
    : undefined,
});

await jobs.recover();
const server = createHttpServer({ token, jobs, ratePerMinute: funnel ? 180 : 0 });
server.listen(port, bind, () => {
  console.log(`vf-diag listening on ${bind}:${port}`);
});
