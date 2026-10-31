/* ============================================================================
   整分对齐时钟

   setInterval(…, 1000) 有两个问题：
     1) 会漂移 —— 累积误差让"跳字"越来越晚
     2) 整分后近 1 秒才跳字 —— 19:59 → 20:00 能明显看到迟滞
   做法：主定时器用 setTimeout 对齐到【下一个展示分钟的边界】，
        每次触发后重新对齐 → 永不累积漂移。
   另外挂一个 250ms 心跳，只负责秒数与进度条填充的平滑推进。

   ★ "展示分钟"而不是"系统分钟"：
     配置里的 time_offset（单位秒）可以不是 60 的整数倍。展示时间 = 系统时间
     + 偏移，所以展示时间的分钟边界一般不在系统整分上（例如 +8 秒时，
     19:40:00 的展示对应系统 19:39:52）。以前这里按系统时间算下一个整分，
     整分事件会晚 52 秒 —— 日期、进度条状态、设置面板里的读数都要等心跳慢慢补，
     看上去就像"偏移量不准"。现在由调用方注入"现在的展示时间"。
   ========================================================================== */

export interface ClockHandlers {
  /** 每次整分（以及启动时）触发一次：适合做"整分钟"才需要的事 */
  onMinute?: (now: Date) => void;
  /** 250ms 心跳：秒数、进度条填充等需要平滑刷新的东西 */
  onTick?: (now: Date) => void;
}

export class MinuteClock {
  private minuteTimer = 0;
  private tickTimer = 0;
  private running = false;

  /**
   * @param h      回调
   * @param nowMs  取"当前展示时间"的毫秒时间戳（默认系统时间）。
   *               main.ts 传的是 Date.now() + time_offset*1000。
   */
  constructor(
    private h: ClockHandlers,
    private nowMs: () => number = Date.now,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const fire = () => {
      if (!this.running) return;
      const now = new Date(this.nowMs());
      this.h.onMinute?.(now);
      this.h.onTick?.(now);
      this.scheduleMinute();
    };
    fire();               // 立刻先跑一次，别等下一分钟
    this.tickTimer = window.setInterval(() => {
      if (this.running) this.h.onTick?.(new Date(this.nowMs()));
    }, 250);
  }

  private scheduleMinute(): void {
    clearTimeout(this.minuteTimer);
    const t = this.nowMs();
    const mod = ((t % 60_000) + 60_000) % 60_000;
    const msToNextMinute = 60_000 - mod;
    // +15ms 余量：确保醒来时已经跨过边界，避免因定时器提前一点点而重复触发同一分钟
    this.minuteTimer = window.setTimeout(() => {
      if (this.running) this.h.onMinute?.(new Date(this.nowMs()));
      this.scheduleMinute();
    }, msToNextMinute + 15);
  }

  /** 休眠唤醒 / 切回前台 / 修改偏移量后调用：立刻重算一次并重新对齐边界 */
  resync(): void {
    if (!this.running) return;
    const now = new Date(this.nowMs());
    this.h.onMinute?.(now);
    this.h.onTick?.(now);
    this.scheduleMinute();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.minuteTimer);
    clearInterval(this.tickTimer);
  }
}

/** "19:29" / "19:29:53" */
export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ss(d: Date): string {
  return String(d.getSeconds()).padStart(2, "0");
}
