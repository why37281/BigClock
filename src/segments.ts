/* ============================================================================
   分段计算 —— 宽度分配 / 三态 / 拉长规则
   全部是纯函数，不碰 DOM，方便单独验证。

   时间基准：把"今天 00:00"当作 0 分。跨零点的段（23:30→00:10）展开成 1410..1450。
   于是"现在"要算两次：now 和 now+1440，取落在某个段里的那个 —— 这样凌晨 00:05
   也能正确认到昨晚 23:30 开始的那一段。
   ========================================================================== */

import { parseTime, type Period } from "./config";

export type SegState = "done" | "now" | "todo";

export interface Segment {
  name: string;
  /** 当天的起始分钟（可能 ≥1440 如果跨零点展开） */
  a: number;
  b: number;
  dur: number;
  state: SegState;
  /** 当前段才有：进度 0..1 */
  progress: number;
}

/** 由用户填写的作息表构建分段；同时把配置里的空洞补成"课间"。 */
export function buildSegments(periods: Period[], fillGaps: boolean): Segment[] {
  const raw: { name: string; a: number; b: number }[] = [];

  for (const p of periods) {
    const name = (p.name ?? "").trim() || "未命名";
    const a = parseTime(p.start);
    let b = parseTime(p.end);
    if (a === null || b === null) continue; // 无效项直接跳过（Rust 侧已经拦过一道）
    if (b <= a) b += 1440;                  // 跨零点
    if (b === a) continue;
    raw.push({ name, a, b });
  }
  raw.sort((x, y) => x.a - y.a);

  if (!fillGaps || raw.length === 0) {
    return raw.map((r) => ({ ...r, dur: r.b - r.a, state: "todo" as SegState, progress: 0 }));
  }

  // 补空洞：只在 0..1440 这一天之内补，跨零点的尾巴不强行补到次日
  const out: { name: string; a: number; b: number }[] = [];
  let cursor = raw[0].a;
  for (const r of raw) {
    if (r.a > cursor) out.push({ name: "课间", a: cursor, b: r.a });
    out.push(r);
    cursor = Math.max(cursor, r.b);
  }
  return out.map((r) => ({ ...r, dur: r.b - r.a, state: "todo" as SegState, progress: 0 }));
}

/** 把时间区间按需 +1440 展开，取一个包含 nowMin（或 nowMin+1440）的版本 */
function contains(a: number, b: number, nowMin: number): number | null {
  if (nowMin >= a && nowMin < b) return nowMin;
  if (nowMin + 1440 >= a && nowMin + 1440 < b) return nowMin + 1440;
  return null;
}

/**
 * 当前时刻（当天分钟数，可带小数）对应的段与进度。
 * 返回 { segments, nowIndex }，segments 里的 state/progress 已填好。
 *
 * 判定基准是单一的"现在瞬间" nowInst：
 *   · 落在某段里     → now
 *   · nowInst >= b   → done
 *   · 其余           → todo
 * 跨零点靠 contains() 里的 +1440 展开处理，所以凌晨 00:05 也能正确认到
 * 昨晚 23:30 开始的那一段（此时 nowInst = 1445，落在 1410..1450 里）。
 */
export function applyNow(segments: Segment[], nowMin: number): { segments: Segment[]; nowIndex: number } {
  let nowIndex = -1;
  let nowInst = nowMin;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const t = contains(s.a, s.b, nowMin);
    if (t !== null && (nowIndex < 0 || t < nowInst)) {
      nowIndex = i;
      nowInst = t;
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (i === nowIndex) {
      s.state = "now";
      s.progress = Math.max(0, Math.min(1, (nowInst - s.a) / s.dur));
    } else {
      s.progress = nowInst >= s.b ? 1 : 0;
      s.state = nowInst >= s.b ? "done" : "todo";
    }
  }
  return { segments, nowIndex };
}

/**
 * 拉长规则（与设计稿一致）：
 *   · 目标长度 = 该段原始时长占比 × GROW_TARGET(250%)
 *   · 上限     = 总宽的 GROW_CAP(70%)
 *   · 其余段按比例让位，保证整条精确占满 100%
 * 返回每段的 flex-grow 值（总和固定为 1，配合 flex-basis:0 即精确占满）。
 */
export function growWeights(
  segments: Segment[],
  nowIndex: number,
  growTarget = 2.5,
  growCap = 0.7,
): number[] {
  const n = segments.length;
  if (n === 0) return [];
  const total = segments.reduce((s, x) => s + x.dur, 0);
  if (total <= 0) return new Array(n).fill(1 / n);

  const base = segments.map((s) => s.dur / total); // 原始占比，和为 1
  if (nowIndex < 0) return base;

  const wantNow = Math.min(base[nowIndex] * growTarget, growCap);
  const rest = 1 - base[nowIndex];
  const shrink = rest > 0 ? (1 - wantNow) / rest : 0;

  const out = base.map((w, i) => (i === nowIndex ? wantNow : w * shrink));
  const sum = out.reduce((a, b) => a + b, 0);
  // 理论上 sum 恒为 1；这里再归一一次，避免浮点误差让整条差几像素
  return sum > 0 ? out.map((w) => w / sum) : base;
}

/** 现在几点几分（带小数秒），用作进度条的"现在" */
export function nowMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** 距离本段结束还有多少分钟（没有当前段时返回 null） */
export function remainingMinutes(segments: Segment[], nowIndex: number, nowMin: number): number | null {
  if (nowIndex < 0) return null;
  const s = segments[nowIndex];
  const t = nowMin >= s.a ? nowMin : nowMin + 1440;
  return Math.max(0, s.b - t);
}
