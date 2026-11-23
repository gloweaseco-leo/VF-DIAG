import { lookup } from "node:dns/promises";
import path from "node:path";
import { assertServiceToken } from "./http/request.ts";
import { createHttpServer } from "./http/server.ts";
import { createJobService } from "./jobs/service.ts";
import { runSiteOne } from "./siteone/run.ts";

const token = assertServiceToken(process.env.VFDIAG_SERVICE_TOKEN);
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

const jobs = createJobService({
  dataDir,
  syntheticHosts,
  lookup: async (hostname) => {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  },
  run: (options) => runSiteOne({ ...options, bin: siteoneBin }),
});

await jobs.recover();
const server = createHttpServer({ token, jobs });
server.listen(port, bind, () => {
  console.log(`vf-diag listening on ${bind}:${port}`);
});
