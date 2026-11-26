import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class PdfRenderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function fetchPrintPdf(options: {
  origin: string;
  token: string;
  jobRef: string;
  revision: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  printHtml?: (html: string, signal: AbortSignal) => Promise<Buffer>;
}): Promise<Buffer> {
  const origin = options.origin.replace(/\/$/, "");
  const url = new URL("/website-diagnosis/print", `${origin}/`);
  if (url.origin !== new URL(origin).origin) throw new PdfRenderError("PDF_RENDER_FAILED", "打印地址无效。");
  const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !local) throw new PdfRenderError("PDF_RENDER_FAILED", "打印地址必须是 VF 的 HTTPS 源。");
  if (options.token.length < 32) throw new PdfRenderError("PDF_NOT_CONFIGURED", "打印凭据至少需要 32 位。");
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET",
    redirect: "error",
    signal: options.signal,
    headers: {
      authorization: `Bearer ${options.token}`,
      "x-vf-job-ref": options.jobRef,
      "x-vf-report-revision": options.revision,
      accept: "text/html",
    },
  });
  if (response.status !== 200) throw new PdfRenderError("PDF_RENDER_FAILED", `打印服务返回 ${response.status}。`);
  const type = response.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (type.includes("text/html")) {
    const html = withBase(bytes.toString("utf8"), origin);
    if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html)) throw new PdfRenderError("PDF_RENDER_FAILED", "打印页不是完整 HTML。");
    const printed = await (options.printHtml ?? chromiumPrint)(html, options.signal);
    if (!printed.subarray(0, 5).toString("utf8").startsWith("%PDF-")) throw new PdfRenderError("PDF_RENDER_FAILED", "Chromium 没有产出 PDF。");
    return printed;
  }
  if (type.includes("application/pdf") && bytes.subarray(0, 5).toString("utf8").startsWith("%PDF-")) return bytes;
  throw new PdfRenderError("PDF_RENDER_FAILED", "打印服务没有返回可打印的页面。");
}

export async function chromiumPrint(html: string, signal: AbortSignal): Promise<Buffer> {
  const bin = process.env.VFDIAG_CHROMIUM?.trim() || "chromium";
  const dir = await mkdtemp(path.join(tmpdir(), "vfdiag-print-"));
  const htmlPath = path.join(dir, "print.html");
  const pdfPath = path.join(dir, "print.pdf");
  const profile = path.join(dir, "profile");
  try {
    await writeFile(htmlPath, html);
    await runChromium(bin, htmlPath, pdfPath, profile, signal);
    return await readFile(pdfPath);
  } catch (error) {
    if (error instanceof PdfRenderError) throw error;
    throw new PdfRenderError("PDF_RENDER_FAILED", "Chromium 打印失败。");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function withBase(html: string, origin: string): string {
  if (/<base\b/i.test(html)) return html;
  const base = `<base href="${origin}/">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (tag) => `${tag}${base}`);
  return `<!DOCTYPE html><html><head>${base}</head><body>${html}</body></html>`;
}

function runChromium(bin: string, htmlPath: string, pdfPath: string, profile: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-pdf-header-footer",
      "--run-all-compositor-stages-before-draw",
      "--virtual-time-budget=20000",
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ], { stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new PdfRenderError("PDF_RENDER_FAILED", "打印超时。"));
    }, 60_000);
    const onAbort = () => {
      child.kill();
      finish(new PdfRenderError("PDF_RENDER_FAILED", "打印已取消。"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      child.kill();
      finish(new PdfRenderError("PDF_RENDER_FAILED", error.code === "ENOENT" ? "容器里没有 Chromium。" : "Chromium 没有启动。"));
    });
    child.on("exit", (code) => {
      if (signal.aborted) return;
      if (code === 0) finish();
      else finish(new PdfRenderError("PDF_RENDER_FAILED", `Chromium 退出码 ${code}。`));
    });
  });
}
