import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "fixtures", "synthetic-site");
const port = Number(process.env.FIXTURE_PORT ?? 8080);
const bind = process.env.FIXTURE_BIND ?? "127.0.0.1";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture.local");
  const requested = decodeURIComponent(url.pathname);
  if (requested === "/redirect-metadata") {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/", "cache-control": "no-store" });
    res.end();
    return;
  }
  if (requested === "/redirect-loopback") {
    res.writeHead(302, { location: "http://127.0.0.1/", "cache-control": "no-store" });
    res.end();
    return;
  }
  if (requested === "/subresource.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      "<!doctype html><title>subresource</title><img src=\"http://169.254.169.254/latest/meta-data/\"><a href=\"/products/valve.html\">valve</a>",
    );
    return;
  }
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const file = path.resolve(root, relative);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (file !== root && !file.startsWith(rootPrefix)) {
    res.writeHead(404);
    res.end();
    return;
  }
  stat(file)
    .then((info) => {
      if (!info.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      createReadStream(file).pipe(res);
    })
    .catch(() => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    });
});

server.listen(port, bind, () => {
  console.log(`synthetic fixture on ${bind}:${port}`);
});
