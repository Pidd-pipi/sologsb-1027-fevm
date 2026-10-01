// 排程引擎：按步骤依赖关系与仪器可用台数，计算各步骤的开始、结束与等待时长。
// 所有函数均为纯函数（除 baseDay 取当天日期外），便于在提交前试算并在失败时回滚。

export interface Instrument {
  id: string;
  name: string;
  count: number;       // 可用台数（同一仪器并行占用上限）
  workStart: string;   // 每日工作开始时间 "HH:mm"
  workEnd: string;     // 每日工作结束时间 "HH:mm"
}

export type ScheduleStatus = 'scheduled' | 'unscheduled';

export interface StepSchedule {
  instrumentId: string;
  instrumentName: string;
  start: string; // ISO
  end: string;   // ISO
  waitMinutes: number;
}

export interface ScheduleConflict {
  stepId: string;
  stepTitle: string;
  instrumentName: string;
  reason: 'window' | 'cycle' | 'dependency-unscheduled' | 'invalid-window';
  ready: string | null;
  candidateStart: string | null;
  windowEnd: string | null;
  shortageMinutes: number;
  capacityLimited: boolean;
  peakDemand: number | null;
  capacity: number | null;
  message: string;
}

export interface ScheduleOutcome {
  schedules: Map<string, StepSchedule>;
  unscheduled: string[];
  conflicts: ScheduleConflict[];
  cycle: boolean;
}

export interface ScheduleStepLike {
  id: string;
  title: string;
  duration: number;
  dependencies: string[];
  instrumentId?: string;
  earliestStart?: string;
}

export function defaultInstruments(): Instrument[] {
  return [
    { id: 'inst-fume-hood', name: '通风柜', count: 2, workStart: '09:00', workEnd: '17:00' },
    { id: 'inst-balance', name: '分析天平', count: 1, workStart: '09:00', workEnd: '17:00' },
    { id: 'inst-bath', name: '恒温循环浴', count: 1, workStart: '09:00', workEnd: '17:00' },
    { id: 'inst-gc', name: '气相色谱仪', count: 1, workStart: '09:00', workEnd: '17:00' }
  ];
}

export function uidInstrument(): string {
  return `inst-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function parseHHmm(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 540;
  const hours = Math.min(23, Number(match[1]));
  const minutes = Math.min(59, Number(match[2]));
  return hours * 60 + minutes;
}

function dayStart(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function setMinuteOfDay(d: Date, minutes: number): Date {
  const x = dayStart(d);
  x.setMinutes(minutes);
  return x;
}

function formatHM(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatScheduleTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface Interval {
  start: Date;
  end: Date;
}

// 计算 [spanStart, spanEnd) 区间内已排程区间的最大重叠深度。
function maxDepth(intervals: Interval[], spanStart: Date, spanEnd: Date): number {
  const events: Array<{ t: number; d: number }> = [];
  for (const iv of intervals) {
    const s = Math.max(iv.start.getTime(), spanStart.getTime());
    const e = Math.min(iv.end.getTime(), spanEnd.getTime());
    if (s >= e) continue;
    events.push({ t: s, d: 1 });
    events.push({ t: e, d: -1 });
  }
  // 同一时刻先释放后占用，保证区间端点不重复计数。
  events.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let max = 0;
  for (const ev of events) {
    cur += ev.d;
    if (cur > max) max = cur;
  }
  return max;
}

interface PlaceResult {
  ok: boolean;
  start?: Date;
  end?: Date;
  candidate?: Date;
  winEnd?: Date;
  capacityLimited: boolean;
  peakDemand: number | null;
  invalidWindow: boolean;
}

// 在仪器的已占用区间中，寻找不超过可用台数的最早开始时刻。
function placeOnInstrument(
  intervals: Interval[],
  durationMin: number,
  ready: Date,
  winStartMin: number,
  winEndMin: number,
  count: number
): PlaceResult {
  if (winEndMin <= winStartMin) {
    return { ok: false, candidate: new Date(ready), winEnd: new Date(ready), capacityLimited: false, peakDemand: null, invalidWindow: true };
  }
  const winStart = setMinuteOfDay(ready, winStartMin);
  const winEnd = setMinuteOfDay(ready, winEndMin);
  let candidate = new Date(Math.max(ready.getTime(), winStart.getTime()));
  let capacityLimited = false;
  let peakDemand: number | null = null;
  for (let guard = 0; guard < 2000; guard++) {
    const end = new Date(candidate.getTime() + durationMin * 60000);
    if (end.getTime() > winEnd.getTime()) {
      return { ok: false, candidate: new Date(candidate), winEnd: new Date(winEnd), capacityLimited, peakDemand, invalidWindow: false };
    }
    const depth = maxDepth(intervals, candidate, end);
    if (depth >= count) {
      capacityLimited = true;
      peakDemand = Math.max(peakDemand ?? 0, depth + 1);
      // 跳到与候选区间相交的已占用区间的最早结束时刻，继续寻找可插入空档。
      let jump = Infinity;
      for (const iv of intervals) {
        if (iv.end.getTime() > candidate.getTime() && iv.start.getTime() < end.getTime()) {
          jump = Math.min(jump, iv.end.getTime());
        }
      }
      if (!Number.isFinite(jump) || jump <= candidate.getTime()) {
        return { ok: false, candidate: new Date(candidate), winEnd: new Date(winEnd), capacityLimited, peakDemand, invalidWindow: false };
      }
      candidate = new Date(jump);
    } else {
      return { ok: true, start: new Date(candidate), end, capacityLimited, peakDemand, invalidWindow: false };
    }
  }
  return { ok: false, candidate: new Date(candidate), winEnd: new Date(winEnd), capacityLimited, peakDemand, invalidWindow: false };
}

// 拓扑排序（Kahn 算法），存在循环时返回 null。
function topoSort(steps: ScheduleStepLike[]): string[] | null {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of steps) {
    indeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of steps) {
    for (const depId of s.dependencies) {
      if (!indeg.has(depId)) continue;
      adj.get(depId)!.push(s.id);
      indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
    }
  }
  const queue = steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return order.length === steps.length ? order : null;
}

function makeConflict(step: ScheduleStepLike, inst: Instrument, ready: Date, result: PlaceResult): ScheduleConflict {
  const candidate = result.candidate ?? ready;
  const end = result.end ?? new Date(candidate.getTime() + Math.max(1, step.duration) * 60000);
  const winEnd = result.winEnd ?? end;
  const shortageMinutes = Math.max(0, Math.round((end.getTime() - winEnd.getTime()) / 60000));
  let message: string;
  if (result.invalidWindow) {
    message = `仪器「${inst.name}」工作时间设置无效：结束时间（${inst.workEnd}）需晚于开始时间（${inst.workStart}）。`;
  } else if (result.capacityLimited) {
    message =
      `步骤「${step.title}」就绪于 ${formatHM(ready)}，需使用仪器「${inst.name}」（${inst.count} 台），但该时段仪器全部占用；` +
      `预计 ${step.duration} 分钟，${formatHM(candidate)} 开始将超过当天工作时间 ${formatHM(winEnd)}，缺口 ${shortageMinutes} 分钟。`;
  } else {
    message =
      `步骤「${step.title}」最早可于 ${formatHM(ready)} 开始，使用仪器「${inst.name}」预计 ${step.duration} 分钟，` +
      `完成时间 ${formatHM(end)} 超过当天工作时间 ${formatHM(winEnd)}，缺口 ${shortageMinutes} 分钟。`;
  }
  return {
    stepId: step.id,
    stepTitle: step.title,
    instrumentName: inst.name,
    reason: result.invalidWindow ? 'invalid-window' : 'window',
    ready: ready.toISOString(),
    candidateStart: candidate.toISOString(),
    windowEnd: winEnd.toISOString(),
    shortageMinutes,
    capacityLimited: result.capacityLimited,
    peakDemand: result.peakDemand,
    capacity: inst.count,
    message
  };
}

// 对全部步骤试算排程。任何步骤无法在当天窗口内容纳时，记入 conflicts，调用方应放弃本次改写。
export function scheduleProcess(steps: ScheduleStepLike[], instruments: Instrument[]): ScheduleOutcome {
  const order = topoSort(steps);
  if (order === null) {
    return { schedules: new Map(), unscheduled: [], conflicts: [], cycle: true };
  }
  const instMap = new Map(instruments.map((i) => [i.id, i]));
  const intervalsByInst = new Map<string, Interval[]>();
  const schedules = new Map<string, StepSchedule>();
  const unscheduled: string[] = [];
  const conflicts: ScheduleConflict[] = [];

  // 无依赖、无不可早于约束的步骤，从当天工作窗口开始排起。
  const baseDay = dayStart(new Date());

  for (const id of order) {
    const step = steps.find((s) => s.id === id)!;
    const inst = step.instrumentId ? instMap.get(step.instrumentId) : undefined;
    if (!inst) {
      unscheduled.push(id);
      continue;
    }
    let ready: Date | null = step.earliestStart ? new Date(step.earliestStart) : null;
    let depReady: Date | null = null;
    let depBlocked = false;
    for (const depId of step.dependencies) {
      if (!steps.some((s) => s.id === depId)) continue;
      const ds = schedules.get(depId);
      if (!ds) {
        // 前置步骤尚未排程（无仪器或本身冲突），本步骤就绪时间无法确定。
        depBlocked = true;
        break;
      }
      const depEnd = new Date(ds.end);
      if (!depReady || depEnd.getTime() > depReady.getTime()) depReady = depEnd;
    }
    if (depBlocked) {
      unscheduled.push(id);
      continue;
    }
    if (depReady) {
      ready = ready ? new Date(Math.max(ready.getTime(), depReady.getTime())) : depReady;
    }
    if (!ready) {
      ready = setMinuteOfDay(baseDay, parseHHmm(inst.workStart));
    }
    const intervals = intervalsByInst.get(inst.id) ?? [];
    const result = placeOnInstrument(
      intervals,
      Math.max(1, step.duration),
      ready,
      parseHHmm(inst.workStart),
      parseHHmm(inst.workEnd),
      inst.count
    );
    if (!result.ok || !result.start || !result.end) {
      conflicts.push(makeConflict(step, inst, ready, result));
      continue;
    }
    intervals.push({ start: result.start, end: result.end });
    intervalsByInst.set(inst.id, intervals);
    const waitMinutes = Math.max(0, Math.round((result.start.getTime() - ready.getTime()) / 60000));
    schedules.set(id, {
      instrumentId: inst.id,
      instrumentName: inst.name,
      start: result.start.toISOString(),
      end: result.end.toISOString(),
      waitMinutes
    });
  }

  return { schedules, unscheduled, conflicts, cycle: false };
}
