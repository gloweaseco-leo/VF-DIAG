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
      accept: "application/pdf",
    },
  });
  if (response.status !== 200) throw new PdfRenderError("PDF_RENDER_FAILED", `打印服务返回 ${response.status}。`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/pdf")) throw new PdfRenderError("PDF_RENDER_FAILED", "打印服务没有返回 PDF。");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.subarray(0, 5).toString("utf8").startsWith("%PDF-")) throw new PdfRenderError("PDF_RENDER_FAILED", "打印结果不是 PDF 文件。");
  return bytes;
}
