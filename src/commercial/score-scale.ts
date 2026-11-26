export type ScoreScale = {
  status: "DETERMINED" | "NOT_FOUND" | "CONFLICT";
  max_score: number | null;
  reason: string;
};

export function deriveScoreScale(html: string): ScoreScale {
  const boxAt = html.indexOf('class="qs-box"');
  if (boxAt < 0) return { status: "NOT_FOUND", max_score: null, reason: "原始报告里没有评分图形。" };
  const slice = boxInner(html, boxAt);
  const ring = slice.match(/conic-gradient\(([^)]*)\)/i);
  const number = slice.match(/qs-donut-inner[\s\S]{0,500}?<span[^>]*>\s*([\d.]+)\s*<\/span>/i);
  if (!ring || !number) return { status: "NOT_FOUND", max_score: null, reason: "评分圆环无法读取。" };
  const style = ring[1].replace(/\s+/g, "");
  const arc = style.match(/0deg([\d.]+)deg,transparent([\d.]+)deg([\d.]+)deg/);
  if (!arc) return { status: "NOT_FOUND", max_score: null, reason: "评分圆环的角度无法读取。" };
  const filled = Number(arc[1]);
  const transparentAt = Number(arc[2]);
  const full = Number(arc[3]);
  const overall = Number(number[1]);
  if (filled !== transparentAt || full <= 0) {
    return { status: "CONFLICT", max_score: null, reason: "评分圆环的起止角度不一致。" };
  }
  const implied: number[] = [overall / (filled / full)];
  const names = [...slice.matchAll(/class="qs-cat-name"[^>]*>([^<]+)</g)];
  for (let index = 0; index < names.length; index += 1) {
    const start = names[index].index ?? 0;
    const end = index + 1 < names.length ? (names[index + 1].index ?? slice.length) : slice.length;
    const row = slice.slice(start, end);
    const width = row.match(/width:\s*([\d.]+)%/i);
    const score = row.match(/text-align:\s*right;">\s*([\d.]+)\s*</i);
    if (!width || !score) continue;
    const fraction = Number(width[1]) / 100;
    if (fraction <= 0 || fraction > 1) return { status: "CONFLICT", max_score: null, reason: "评分条宽度不在 0 到 100 之间。" };
    implied.push(Number(score[1]) / fraction);
  }
  if (implied.length !== 6) return { status: "CONFLICT", max_score: null, reason: "评分分项不是 5 项。" };
  if (implied.some((value) => Math.abs(value - 10) > 0.001)) {
    return { status: "CONFLICT", max_score: null, reason: "圆环和分项条没有共同指向满分 10。" };
  }
  return { status: "DETERMINED", max_score: 10, reason: "满分 10 由原始报告图形比例确定，报告文字没有直接写出满分。" };
}

function boxInner(html: string, classAt: number): string {
  const open = html.lastIndexOf("<div", classAt);
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = open;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, match.index + match[0].length);
  }
  return html.slice(open, open + 20000);
}
