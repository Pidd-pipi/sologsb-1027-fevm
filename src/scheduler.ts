// 当日仪器排程引擎：纯函数，可被 UI、版本快照比较复用。
// 规则：
// 1) 步骤开始时间 = max(前置步骤结束时间, 不可早于时间, 仪器空闲台位时间, 仪器上班时间)；
// 2) 同一仪器并行占用数不得超过可用台数；
// 3) 任一步骤无法在仪器当天工作窗口内完成即排程失效，返回冲突步骤与每台仪器的容量缺口；
// 4) 未选择仪器的步骤标记为“未排程”，不计入冲突（旧数据升级后即此状态）。

export interface Instrument {
  id: string;
  name: string;
  capacity: number; // 可用台数
  workStart: string; // HH:mm
  workEnd: string; // HH:mm
}

export interface ScheduledEntry {
  stepId: string;
  instrumentId: string;
  instrumentName: string;
  start: number; // 距当天 00:00 的分钟数
  end: number;
  wait: number; // 满足依赖与不可早于条件后，实际排队等待仪器的分钟数
  lane: number; // 占用该仪器的第几台（供甘特图分行）
}

export type ConflictReason =
  | 'cycle'
  | 'bad-duration'
  | 'unknown-instrument'
  | 'instrument-config'
  | 'dep-blocked'
  | 'earliest-future'
  | 'overflow';

export interface ScheduleConflict {
  stepId?: string;
  instrumentId?: string;
  reason: ConflictReason;
  message: string;
  overflow?: number; // 超出当天工作窗口的分钟数
}

export interface CapacityGap {
  instrumentId: string;
  instrumentName: string;
  capacity: number;
  peakOverlap: number; // 当天峰值并行占用数
  shortfall: number; // 窗口外被迫占用的分钟数（容量缺口）
}

export interface ScheduleResult {
  date: string; // YYYY-MM-DD
  valid: boolean;
  entries: ScheduledEntry[];
  conflicts: ScheduleConflict[];
  gaps: CapacityGap[];
  unscheduledStepIds: string[];
  windowStart: number;
  windowEnd: number;
}

export interface ScheduleStepInput {
  id: string;
  title?: string;
  duration: number;
  dependencies: string[];
  instrumentId?: string;
  earliestStart?: string; // datetime-local：YYYY-MM-DDTHH:mm
}

const DEFAULT_WINDOW_START = 8 * 60;
const DEFAULT_WINDOW_END = 18 * 60;

export function toMinutes(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatClock(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

export function todayDateInput(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function mergeDateTime(date: string, hhmm: string): string {
  return `${date}T${hhmm}`;
}

function parseEarliest(value: string | undefined): { day: string; minute: number } | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  return { day: match[1], minute: Number(match[2]) * 60 + Number(match[3]) };
}

interface InstrumentRuntime {
  instrument: Instrument;
  workStart: number;
  workEnd: number;
  availableAt: number[]; // 每台设备下次可用的分钟数
  tasks: { start: number; end: number; lane: number }[][]; // 每台设备上的任务
}

export function buildSchedule(
  date: string,
  instruments: Instrument[],
  steps: ScheduleStepInput[]
): ScheduleResult {
  const conflicts: ScheduleConflict[] = [];
  const unscheduledStepIds: string[] = [];
  const instrumentMap = new Map(instruments.map((instrument) => [instrument.id, instrument]));

  // 仪器台账自身校验：台数与工作时间非法时，占用它的步骤一律无法排。
  const brokenInstrumentIds = new Set<string>();
  instruments.forEach((instrument) => {
    const start = toMinutes(instrument.workStart);
    const end = toMinutes(instrument.workEnd);
    if (!instrument.capacity || instrument.capacity < 1 || start === null || end === null || start >= end) {
      brokenInstrumentIds.add(instrument.id);
      conflicts.push({
        instrumentId: instrument.id,
        reason: 'instrument-config',
        message: `仪器「${instrument.name || '未命名'}」台数需 ≥ 1，且工作开始时间需早于结束时间。`
      });
    }
  });

  const stepMap = new Map(steps.map((step) => [step.id, step]));
  const entries: ScheduledEntry[] = [];
  const entryMap = new Map<string, ScheduledEntry>();
  const runtimes = new Map<string, InstrumentRuntime>();

  const windowStart = instruments.length
    ? Math.min(...instruments.map((instrument) => toMinutes(instrument.workStart) ?? DEFAULT_WINDOW_START))
    : DEFAULT_WINDOW_START;
  const windowEnd = instruments.length
    ? Math.max(...instruments.map((instrument) => toMinutes(instrument.workEnd) ?? DEFAULT_WINDOW_END))
    : DEFAULT_WINDOW_END;

  // Kahn 拓扑排序，同层按步骤原顺序，保证结果稳定可复现。
  const indegree = new Map<string, number>();
  steps.forEach((step) => {
    indegree.set(step.id, step.dependencies.filter((dep) => stepMap.has(dep)).length);
  });
  const ordered: ScheduleStepInput[] = [];
  const ready = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0);
  const readyQueue = [...ready];
  while (readyQueue.length) {
    const step = readyQueue.shift()!;
    ordered.push(step);
    steps.forEach((candidate) => {
      if (!candidate.dependencies.includes(step.id)) return;
      const next = (indegree.get(candidate.id) ?? 1) - 1;
      indegree.set(candidate.id, next);
      if (next === 0) readyQueue.push(candidate);
    });
  }
  // 拓扑排序无法消费的步骤：依赖成环（含依赖环上步骤的节点）。
  steps.forEach((step) => {
    if (!ordered.includes(step)) {
      conflicts.push({
        stepId: step.id,
        reason: 'cycle',
        message: '前置依赖存在环，无法推算开始时间，请检查依赖关系。'
      });
    }
  });

  const runtimeFor = (instrument: Instrument): InstrumentRuntime | null => {
    if (brokenInstrumentIds.has(instrument.id)) return null;
    const existing = runtimes.get(instrument.id);
    if (existing) return existing;
    const workStart = toMinutes(instrument.workStart)!;
    const workEnd = toMinutes(instrument.workEnd)!;
    const runtime: InstrumentRuntime = {
      instrument,
      workStart,
      workEnd,
      availableAt: Array.from({ length: instrument.capacity }, () => workStart),
      tasks: Array.from({ length: instrument.capacity }, () => [])
    };
    runtimes.set(instrument.id, runtime);
    return runtime;
  };

  ordered.forEach((step) => {
    if (!(Number(step.duration) > 0)) {
      conflicts.push({ stepId: step.id, reason: 'bad-duration', message: '预计时长需为大于 0 的分钟数。' });
      return;
    }

    if (!step.instrumentId) {
      unscheduledStepIds.push(step.id);
      return;
    }

    const instrument = instrumentMap.get(step.instrumentId);
    if (!instrument) {
      conflicts.push({ stepId: step.id, reason: 'unknown-instrument', message: '所选仪器已不存在，请重新选择仪器。' });
      return;
    }
    if (brokenInstrumentIds.has(instrument.id)) {
      conflicts.push({
        stepId: step.id,
        instrumentId: instrument.id,
        reason: 'instrument-config',
        message: `仪器「${instrument.name}」的台数或工作时间配置无效，无法排入。`
      });
      return;
    }

    // 前置步骤只要有任一未排程（未选仪器 / 冲突 / 成环），本步骤就无法确定开始时间。
    const blocking = step.dependencies.filter((dep) => stepMap.has(dep) && !entryMap.has(dep));
    if (blocking.length) {
      const names = blocking
        .map((id) => stepMap.get(id)?.title || id)
        .join('、');
      conflicts.push({
        stepId: step.id,
        reason: 'dep-blocked',
        message: `前置步骤「${names}」尚未排程，当前步骤无法开始。`
      });
      return;
    }

    const dependencyReady = step.dependencies.reduce<number | null>((max, dep) => {
      const entry = entryMap.get(dep);
      return entry === undefined ? max : Math.max(max ?? -Infinity, entry.end);
    }, null);

    const earliest = parseEarliest(step.earliestStart);
    if (earliest && earliest.day > date) {
      conflicts.push({
        stepId: step.id,
        reason: 'earliest-future',
        message: `不可早于时间为 ${step.earliestStart!.slice(0, 16).replace('T', ' ')}，不在排程当天 ${date} 的窗口内。`
      });
      return;
    }
    const earliestReady = earliest && earliest.day === date ? earliest.minute : null;
    const readyTime = Math.max(dependencyReady ?? -Infinity, earliestReady ?? -Infinity);

    const runtime = runtimeFor(instrument)!;
    let lane = 0;
    for (let index = 1; index < runtime.availableAt.length; index += 1) {
      if (runtime.availableAt[index] < runtime.availableAt[lane]) lane = index;
    }
    // availableAt 初始化为上班时间，天然把步骤钳制在仪器工作窗口起点之后。
    const start = Math.max(readyTime, runtime.availableAt[lane]);
    const end = start + Number(step.duration);

    // 等待时长：前置步骤均完成（且仪器已开门）之后，到实际开始之间的等待；
    // 包含不可早于时间约束与仪器台位被占导致的排队，开门前的时间不计。
    const eligible = Math.max(dependencyReady ?? -Infinity, runtime.workStart);
    const wait = Number.isFinite(eligible) ? Math.max(0, start - eligible) : 0;

    const entry: ScheduledEntry = {
      stepId: step.id,
      instrumentId: instrument.id,
      instrumentName: instrument.name,
      start,
      end,
      wait,
      lane
    };
    entries.push(entry);
    entryMap.set(step.id, entry);
    runtime.availableAt[lane] = end;
    runtime.tasks[lane].push({ start, end, lane });

    if (end > runtime.workEnd) {
      conflicts.push({
        stepId: step.id,
        instrumentId: instrument.id,
        reason: 'overflow',
        message: `预计 ${formatClock(end)} 结束，超出仪器「${instrument.name}」当天工作时间 ${instrument.workEnd}，窗口内容量不足。`,
        overflow: end - runtime.workEnd
      });
    }
  });

  // 汇总每台仪器的容量缺口与峰值并行度。
  const gaps: CapacityGap[] = [];
  runtimes.forEach((runtime) => {
    let shortfall = 0;
    runtime.tasks.forEach((laneTasks) => {
      laneTasks.forEach((task) => {
        if (task.end > runtime.workEnd) shortfall += task.end - runtime.workEnd;
      });
    });
    const events = entries
      .filter((entry) => entry.instrumentId === runtime.instrument.id)
      .flatMap((entry) => [{ at: entry.start, delta: 1 }, { at: entry.end, delta: -1 }])
      .sort((a, b) => a.at - b.at || a.delta - b.delta);
    let peakOverlap = 0;
    let active = 0;
    events.forEach((event) => {
      active += event.delta;
      peakOverlap = Math.max(peakOverlap, active);
    });
    if (shortfall > 0 || peakOverlap > runtime.instrument.capacity) {
      gaps.push({
        instrumentId: runtime.instrument.id,
        instrumentName: runtime.instrument.name,
        capacity: runtime.instrument.capacity,
        peakOverlap,
        shortfall
      });
    }
  });

  return {
    date,
    valid: conflicts.length === 0,
    entries: entries.sort((a, b) => a.start - b.start || a.instrumentId.localeCompare(b.instrumentId)),
    conflicts,
    gaps,
    unscheduledStepIds,
    windowStart,
    windowEnd
  };
}

export interface ScheduleCompareRow {
  id: string;
  title: string;
  base?: ScheduledEntry;
  target?: ScheduledEntry;
  baseScheduled: boolean;
  targetScheduled: boolean;
  changed: boolean;
}

// 版本比较：按步骤并排给出两侧的仪器 / 开始 / 结束 / 等待时长。
export function compareScheduleEntries(
  baseResult: ScheduleResult | undefined,
  targetResult: ScheduleResult | undefined,
  baseSteps: ScheduleStepInput[],
  targetSteps: ScheduleStepInput[]
): ScheduleCompareRow[] {
  const baseMap = new Map(baseResult?.entries.map((entry) => [entry.stepId, entry]));
  const targetMap = new Map(targetResult?.entries.map((entry) => [entry.stepId, entry]));
  const baseScheduled = new Set(baseResult?.unscheduledStepIds.length === 0 ? baseSteps.map((step) => step.id) : []);
  baseResult?.entries.forEach((entry) => baseScheduled.add(entry.stepId));
  const targetScheduled = new Set<string>();
  targetResult?.entries.forEach((entry) => targetScheduled.add(entry.stepId));

  const titles = new Map<string, string>();
  targetSteps.forEach((step) => titles.set(step.id, step.title || step.id));
  baseSteps.forEach((step) => titles.set(step.id, step.title || step.id));

  const ids: string[] = [];
  targetSteps.forEach((step) => ids.push(step.id));
  baseSteps.forEach((step) => {
    if (!ids.includes(step.id)) ids.push(step.id);
  });

  return ids.map((id) => {
    const base = baseMap.get(id);
    const target = targetMap.get(id);
    const changed =
      Boolean(base) !== Boolean(target) ||
      (base !== undefined && target !== undefined &&
        (base.instrumentId !== target.instrumentId ||
          base.start !== target.start ||
          base.end !== target.end ||
          base.wait !== target.wait));
    return {
      id,
      title: titles.get(id) || id,
      base,
      target,
      baseScheduled: baseScheduled.has(id),
      targetScheduled: targetScheduled.has(id),
      changed
    };
  });
}
