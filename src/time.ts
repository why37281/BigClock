/* ============================================================================
   整分对齐时钟

   setInterval(…, 1000) 有两个问题：
     1) 会漂移 —— 累积误差让"跳字"越来越晚
     2) 整分后近 1 秒才跳字 —— 19:59 → 20:00 能明显看到迟滞
   做法：主定时器用 setTimeout 对齐到【下一个本地分钟边界】
        （60000 - Date.now() % 60000），每次触发后重新对齐 → 永不累积漂移。
   另外挂一个 250ms 心跳，只负责秒数与进度条填充的平滑推进。
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

  constructor(private h: ClockHandlers) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const fire = () => {
      if (!this.running) return;
      this.h.onMinute?.(new Date());
      this.h.onTick?.(new Date());
      this.scheduleMinute();
    };
    fire();               // 立刻先跑一次，别等下一分钟
    this.tickTimer = window.setInterval(() => {
      if (this.running) this.h.onTick?.(new Date());
    }, 250);
  }

  private scheduleMinute(): void {
    clearTimeout(this.minuteTimer);
    const now = Date.now();
    const msToNextMinute = 60_000 - (now % 60_000);
    // +15ms 余量：确保醒来时已经跨过边界，避免因定时器提前一点点而重复触发同一分钟
    this.minuteTimer = window.setTimeout(() => {
      if (this.running) this.h.onMinute?.(new Date());
      this.scheduleMinute();
    }, msToNextMinute + 15);
  }

  /** 休眠唤醒 / 切回前台后调用：立刻重算一次并重新对齐边界 */
  resync(): void {
    if (!this.running) return;
    this.h.onMinute?.(new Date());
    this.h.onTick?.(new Date());
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
