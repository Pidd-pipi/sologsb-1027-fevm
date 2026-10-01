import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Divider,
  Elevation,
  FormGroup,
  HTMLSelect,
  Icon,
  InputGroup,
  NumericInput,
  ProgressBar,
  Tab,
  Tabs,
  Tag,
  TextArea
} from '@blueprintjs/core';
import {
  buildSchedule,
  compareScheduleEntries,
  formatClock,
  mergeDateTime,
  todayDateInput,
  type Instrument,
  type ScheduleResult
} from './scheduler';

type StepStatus = 'draft' | 'submitted' | 'confirmed' | 'returned';
type ProcessStatus = 'draft' | 'in-review' | 'frozen' | 'revising';
type ViewId = 'editor' | 'schedule' | 'review' | 'compare';

interface ReviewComment {
  id: string;
  author: string;
  role: string;
  text: string;
  createdAt: string;
  resolved: boolean;
}

interface ProcessStep {
  id: string;
  title: string;
  purpose: string;
  materials: string;
  equipment: string;
  amount: string;
  duration: number;
  hazards: string[];
  controls: string;
  dependencies: string[];
  safetyNote: string;
  expectedResult: string;
  status: StepStatus;
  comments: ReviewComment[];
  instrumentId?: string; // 排程所选仪器（台账中的一台仪器类型）
  earliestStart?: string; // 不可早于时间，datetime-local：YYYY-MM-DDTHH:mm
}

interface VersionSnapshot {
  id: string;
  label: string;
  version: string;
  createdAt: string;
  note: string;
  author: string;
  steps: ProcessStep[];
  instruments: Instrument[];
  scheduleDate: string;
  schedule?: ScheduleResult; // 冻结时刻的有效排程快照；旧版本无此字段即视为未排程
}

interface ExperimentProcess {
  id: string;
  title: string;
  code: string;
  objective: string;
  principal: string;
  lab: string;
  status: ProcessStatus;
  version: string;
  steps: ProcessStep[];
  versions: VersionSnapshot[];
  instruments: Instrument[];
  scheduleDate: string; // 当天排程日期 YYYY-MM-DD
  lastValidSchedule?: ScheduleResult; // 最近一次有效排程；输入变更导致失效时保留，作为拒绝改写的回退
  frozenAt?: string;
  updatedAt: string;
}

interface HistoryState {
  past: ExperimentProcess[];
  present: ExperimentProcess;
  future: ExperimentProcess[];
}

interface DiffItem {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
}

const STORAGE_KEY = 'sologsb-1027-lab-safety-v2';
const CURRENT_AUTHOR = '周宁';
const CURRENT_ROLE = '安全复核员';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const DEFAULT_INSTRUMENTS: Instrument[] = [
  { id: 'inst-hood', name: '通风柜', capacity: 2, workStart: '08:30', workEnd: '18:00' },
  { id: 'inst-bath', name: '恒温循环浴', capacity: 1, workStart: '08:30', workEnd: '18:00' },
  { id: 'inst-balance', name: '分析天平', capacity: 1, workStart: '08:30', workEnd: '17:30' },
  { id: 'inst-gc', name: '气相色谱', capacity: 1, workStart: '09:00', workEnd: '17:00' }
];

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function initialProcess(): ExperimentProcess {
  const today = todayDateInput();
  const baseSteps: ProcessStep[] = [
    {
      id: 'step-1', title: '核对试剂与实验区域', purpose: '确认所需物料、设备及区域状态符合实验方案。',
      materials: '无水乙醇、去离子水', equipment: '通风柜、防爆柜、标签打印机', amount: '乙醇 120 mL；去离子水 300 mL',
      duration: 15, hazards: ['易燃液体'], controls: '在通风柜内取用，远离点火源；使用接地金属容器。',
      dependencies: [], safetyNote: '操作人员需佩戴护目镜和防化手套。', expectedResult: '试剂标签、数量和有效期均核对无误。',
      instrumentId: 'inst-hood', earliestStart: mergeDateTime(today, '08:30'),
      status: 'confirmed', comments: [
        { id: 'c-1', author: '李明', role: '研究员', text: '已核对批号和有效期，防爆柜温度记录正常。', createdAt: '2026-09-24T09:10:00+08:00', resolved: true }
      ]
    },
    {
      id: 'step-2', title: '搭建恒温循环装置', purpose: '连接循环浴与反应夹套，检查密封和温控。',
      materials: '无', equipment: '恒温循环浴、硅胶管、反应夹套、扎带', amount: '循环液 800 mL',
      duration: 25, hazards: ['烫伤', '管路脱落'], controls: '管路双端固定；升温前完成 5 分钟试压并设置独立超温断电。',
      dependencies: ['step-1'], safetyNote: '高温表面设置警示标识，循环浴周围保持干燥。', expectedResult: '30 分钟内温度稳定在 55 ± 0.5 ℃。',
      instrumentId: 'inst-bath',
      status: 'confirmed', comments: [
        { id: 'c-2', author: '王颖', role: '安全复核员', text: '补充超温断电值，不能只依赖设备自带温控。', createdAt: '2026-09-24T10:05:00+08:00', resolved: true }
      ]
    },
    {
      id: 'step-3', title: '加入催化剂并启动反应', purpose: '按批次加入催化剂，记录起点并开始计时。',
      materials: '催化剂 A', equipment: '分析天平、加料漏斗、计时器', amount: '催化剂 A 2.50 ± 0.02 g',
      duration: 20, hazards: ['粉尘吸入', '放热反应'], controls: '在通风柜内称量，佩戴 N95 口罩；分三次少量加入并监测温度。',
      dependencies: ['step-2'], safetyNote: '反应温度超过 70 ℃ 时立即停止加料并启动冷却。', expectedResult: '温度缓慢升至 62–66 ℃，无明显冲料。',
      instrumentId: 'inst-balance',
      status: 'submitted', comments: []
    },
    {
      id: 'step-4', title: '恒温反应与过程取样', purpose: '维持温度并定时取样观察反应转化。',
      materials: '样品瓶、惰性气体', equipment: '取样针、气相色谱、恒温循环浴', amount: '每点样品约 1 mL，共 6 点',
      duration: 90, hazards: ['高温液体', '挥发性气体'], controls: '取样前泄压；使用长针和防护屏；样品瓶及时封闭。',
      dependencies: ['step-3'], safetyNote: '取样时不得正对瓶口，样品瓶不得完全密封后加热。', expectedResult: '转化率达到 95% 以上且无异常副产物。',
      instrumentId: 'inst-bath', earliestStart: mergeDateTime(today, '10:30'),
      status: 'submitted', comments: []
    },
    {
      id: 'step-5', title: '停止加热并冷却', purpose: '终止反应并将体系降至安全温度。',
      materials: '无', equipment: '循环浴、温度探头', amount: '降温目标 ≤ 30 ℃', duration: 35,
      hazards: ['烫伤', '残余反应'], controls: '先停止加料并维持搅拌，再以不超过 1 ℃/min 的速率降温。',
      dependencies: ['step-4'], safetyNote: '确认温度连续 5 分钟低于 30 ℃ 后才能拆除装置。', expectedResult: '体系温度稳定低于 30 ℃。',
      instrumentId: 'inst-bath',
      status: 'draft', comments: []
    },
    {
      id: 'step-6', title: '废液分类与现场恢复', purpose: '按危险废物要求分类收集并恢复实验区域。',
      materials: '废液桶、吸附棉', equipment: '防化手套、护目镜、危废标签', amount: '按实际产生量记录', duration: 25,
      hazards: ['废液混装', '化学暴露'], controls: '有机废液单独收集，核对相容性后贴标签；泄漏吸附材料按危废处置。',
      dependencies: ['step-5'], safetyNote: '废液不得倒入下水道，现场恢复后完成双人确认。', expectedResult: '废液交接记录完整，台面无残留。',
      instrumentId: 'inst-hood',
      status: 'draft', comments: []
    }
  ];

  const firstVersion: VersionSnapshot = {
    id: 'version-1-0', label: '首版批准流程', version: '1.0.0', createdAt: '2026-09-20T14:30:00+08:00',
    note: '建立基础反应与取样步骤。', author: '王颖',
    steps: clone(baseSteps).slice(0, 4).map((step) => ({ ...step, status: 'confirmed', comments: [], instrumentId: undefined, earliestStart: undefined })),
    instruments: [], scheduleDate: ''
  };
  const secondVersion: VersionSnapshot = {
    id: 'version-1-1', label: '补充冷却与废液步骤', version: '1.1.0', createdAt: '2026-09-24T15:10:00+08:00',
    note: '增加安全冷却、废液处置和现场恢复。', author: '王颖',
    steps: clone(baseSteps).map((step) => ({ ...step, status: 'confirmed', comments: [], instrumentId: undefined, earliestStart: undefined })),
    instruments: [], scheduleDate: ''
  };

  return {
    id: 'exp-catalyst-2026-09', title: '负载型催化剂评价实验', code: 'SAFE-CAT-026',
    objective: '在受控温度下评价催化剂活性，并完整记录过程样品与安全复核。',
    principal: '李明', lab: '材料化学实验室 B-207',
    status: 'in-review', version: '1.2.0-draft',
    steps: baseSteps, versions: [firstVersion, secondVersion],
    instruments: clone(DEFAULT_INSTRUMENTS), scheduleDate: today,
    updatedAt: new Date().toISOString()
  };
}

function historyReducer(state: HistoryState, action:
  | { type: 'commit'; update: (draft: ExperimentProcess) => void }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; value: ExperimentProcess }
): HistoryState {
  if (action.type === 'commit') {
    const previous = clone(state.present);
    const next = clone(state.present);
    action.update(next);
    next.updatedAt = new Date().toISOString();
    // 输入一变立即重算：有效则刷新受影响排程；当天窗口容量不足时拒绝改写，保留改动前的有效排程。
    const recomputed = buildSchedule(next.scheduleDate, next.instruments, next.steps);
    if (recomputed.valid) {
      next.lastValidSchedule = recomputed;
    } else {
      next.lastValidSchedule = previous.lastValidSchedule;
    }
    return { past: [...state.past.slice(-59), previous], present: next, future: [] };
  }
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return { past: state.past.slice(0, -1), present: previous, future: [clone(state.present), ...state.future].slice(0, 60) };
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return { past: [...state.past, clone(state.present)].slice(-60), present: next, future: state.future.slice(1) };
  }
  return { past: [], present: action.value, future: [] };
}

function migrateProcess(value: Partial<ExperimentProcess>): ExperimentProcess {
  const today = todayDateInput();
  const steps = Array.isArray(value.steps) ? value.steps : [];
  // 旧数据升级：历史步骤没有仪器选择，清除排程字段并在打开后标为未排程。
  const migratedSteps = steps.map((step) => ({
    ...step,
    instrumentId: typeof step.instrumentId === 'string' ? step.instrumentId : undefined,
    earliestStart: typeof step.earliestStart === 'string' ? step.earliestStart : undefined
  }));
  // 旧版本快照同样升级：不重算排程，缺少 schedule 即按未排程展示。
  const migratedVersions = Array.isArray(value.versions)
    ? value.versions.map((version) => ({
        ...version,
        instruments: Array.isArray(version.instruments) ? version.instruments : [],
        scheduleDate: typeof version.scheduleDate === 'string' ? version.scheduleDate : '',
        schedule: version.schedule,
        steps: version.steps.map((step) => ({
          ...step,
          instrumentId: typeof step.instrumentId === 'string' ? step.instrumentId : undefined,
          earliestStart: typeof step.earliestStart === 'string' ? step.earliestStart : undefined
        }))
      }))
    : [];
  return {
    id: value.id || uid('exp'),
    title: value.title || '未命名实验',
    code: value.code || '',
    objective: value.objective || '',
    principal: value.principal || '',
    lab: value.lab || '',
    status: value.status || 'draft',
    version: value.version || '1.0.0-draft',
    steps: migratedSteps,
    versions: migratedVersions,
    instruments: Array.isArray(value.instruments) && value.instruments.length ? value.instruments : clone(DEFAULT_INSTRUMENTS),
    scheduleDate: typeof value.scheduleDate === 'string' && value.scheduleDate ? value.scheduleDate : today,
    lastValidSchedule: value.lastValidSchedule,
    frozenAt: value.frozenAt,
    updatedAt: value.updatedAt || new Date().toISOString()
  };
}

function loadProcess(): ExperimentProcess {
  let base: ExperimentProcess;
  try {
    const value = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('sologsb-1027-lab-safety-v1');
    if (!value) {
      base = initialProcess();
    } else {
      const parsed = JSON.parse(value) as Partial<ExperimentProcess>;
      if (!parsed.id || !Array.isArray(parsed.steps)) {
        base = initialProcess();
      } else {
        // 旧数据升级：历史步骤缺少仪器选择，升级后照常打开并由下方重算标为未排程/冲突。
        base = migrateProcess(parsed);
      }
    }
  } catch {
    base = initialProcess();
  }
  // 打开即按当前台账与步骤重算：有效则展示排程，无效则全部标为未排程/冲突，不写入半截时间。
  const loaded = buildSchedule(base.scheduleDate, base.instruments, base.steps);
  base.lastValidSchedule = loaded.valid ? loaded : undefined;
  return base;
}

function splitList(value: string): string[] {
  return value.split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean);
}

function statusLabel(status: StepStatus): string {
  return status === 'confirmed' ? '已确认' : status === 'returned' ? '已退回' : status === 'submitted' ? '待复核' : '草稿';
}

function processStatusLabel(status: ProcessStatus): string {
  return status === 'frozen' ? '已冻结' : status === 'in-review' ? '复核中' : status === 'revising' ? '修订中' : '草稿';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function conflictLabel(reason: string): string {
  const labels: Record<string, string> = {
    cycle: '依赖成环',
    'bad-duration': '时长无效',
    'unknown-instrument': '仪器缺失',
    'instrument-config': '台账配置',
    'dep-blocked': '依赖未排程',
    'earliest-future': '超出当天',
    overflow: '窗口溢出'
  };
  return labels[reason] ?? '冲突';
}

interface GanttProps {
  instruments: Instrument[];
  schedule: ScheduleResult;
  selectedStepId: string;
  onSelectStep: (stepId: string) => void;
  conflictStepIds: Set<string>;
}

function ScheduleGantt({ instruments, schedule, selectedStepId, onSelectStep, conflictStepIds }: GanttProps) {
  // 时间轴范围：取所有仪器窗口与实际任务端点的并集，越界段同样可见。
  const bounds = instruments.flatMap((instrument) => {
    const start = /^(\d{1,2}):(\d{2})$/.exec(instrument.workStart);
    const end = /^(\d{1,2}):(\d{2})$/.exec(instrument.workEnd);
    return [
      start ? Number(start[1]) * 60 + Number(start[2]) : 8 * 60,
      end ? Number(end[1]) * 60 + Number(end[2]) : 18 * 60
    ];
  });
  schedule.entries.forEach((entry) => { bounds.push(entry.start, entry.end); });
  if (!bounds.length) { bounds.push(8 * 60, 18 * 60); }
  const axisStart = Math.floor(Math.min(...bounds) / 30) * 30;
  const axisEnd = Math.ceil(Math.max(...bounds) / 30) * 30;
  const span = Math.max(60, axisEnd - axisStart);
  const tickCount = Math.round(span / 30);
  const percent = (minute: number) => ((minute - axisStart) / span) * 100;

  return (
    <div className="gantt">
      <div className="gantt-axis" style={{ paddingLeft: 132 }}>
        {Array.from({ length: tickCount + 1 }, (_, index) => axisStart + index * 30).map((minute) => (
          <span key={minute} className="gantt-tick" style={{ left: `${percent(minute)}%` }}>{formatClock(minute)}</span>
        ))}
      </div>
      {instruments.map((instrument) => {
        const workStart = /^(\d{1,2}):(\d{2})$/.exec(instrument.workStart);
        const workEnd = /^(\d{1,2}):(\d{2})$/.exec(instrument.workEnd);
        const winStart = workStart ? Number(workStart[1]) * 60 + Number(workStart[2]) : axisStart;
        const winEnd = workEnd ? Number(workEnd[1]) * 60 + Number(workEnd[2]) : axisEnd;
        const lanes = Array.from({ length: Math.max(1, instrument.capacity) }, (_, lane) =>
          schedule.entries.filter((entry) => entry.instrumentId === instrument.id && entry.lane === lane)
        );
        return (
          <div className="gantt-row" key={instrument.id}>
            <div className="gantt-label">
              <strong>{instrument.name}</strong>
              <small>{instrument.capacity} 台 · {instrument.workStart}–{instrument.workEnd}</small>
            </div>
            <div className="gantt-lanes">
              <div className="gantt-window" style={{ left: `${percent(winStart)}%`, width: `${Math.max(0, percent(winEnd) - percent(winStart))}%` }} />
              {lanes.map((entries, laneIndex) => (
                <div className="gantt-lane" key={laneIndex}>
                  {entries.map((entry) => {
                    const overflow = entry.end > winEnd;
                    const isConflict = Boolean(conflictStepIds.has(entry.stepId)) || overflow;
                    return (
                      <button
                        key={entry.stepId}
                        className={`gantt-block ${isConflict ? 'overflow' : ''} ${entry.stepId === selectedStepId ? 'selected' : ''}`}
                        style={{ left: `${percent(entry.start)}%`, width: `${Math.max(1.2, percent(entry.end) - percent(entry.start))}%` }}
                        title={`${entry.instrumentName} #${entry.lane + 1} · ${formatClock(entry.start)}–${formatClock(entry.end)}${entry.wait ? ` · 等待 ${entry.wait} 分` : ''}`}
                        onClick={() => onSelectStep(entry.stepId)}
                      >
                        <span className="gantt-block-time">{formatClock(entry.start)}–{formatClock(entry.end)}</span>
                        {entry.wait > 0 && <span className="gantt-block-wait">等{entry.wait}′</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {!instruments.length && <p className="muted">维护仪器后台账后这里显示按台位分行的占用时间线。</p>}
    </div>
  );
}

function App() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({ past: [], present: loadProcess(), future: [] }));
  const process = history.present;
  const [selectedStepId, setSelectedStepId] = useState(process.steps[0]?.id ?? '');
  const [activeView, setActiveView] = useState<ViewId>('editor');
  const [lastModifiedId, setLastModifiedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [savedLabel, setSavedLabel] = useState('本地数据已载入');
  const [online, setOnline] = useState(true);
  const [compareBaseId, setCompareBaseId] = useState(process.versions[0]?.id ?? '');
  const [compareTargetId, setCompareTargetId] = useState(process.versions.at(-1)?.id ?? '');
  const initialSaveSkipped = useRef(false);

  const selectedStep = process.steps.find((step) => step.id === selectedStepId) ?? process.steps[0];
  const downstreamIds = useMemo(() => collectDownstream(process.steps, lastModifiedId), [process.steps, lastModifiedId]);
  const impactedSteps = process.steps.filter((step) => downstreamIds.includes(step.id));
  const missingSafetySteps = process.steps.filter(hasMissingSafety);
  const pendingReviewCount = process.steps.filter((step) => step.status === 'submitted' || step.status === 'returned').length;
  const confirmedCount = process.steps.filter((step) => step.status === 'confirmed').length;
  const reviewProgress = process.steps.length ? Math.round((confirmedCount / process.steps.length) * 100) : 0;
  // 试算排程：任一输入（时长/依赖/仪器/不可早于/台数/工作时间）变化立即失效重算。
  const trialSchedule = useMemo(
    () => buildSchedule(process.scheduleDate, process.instruments, process.steps),
    [process.scheduleDate, process.instruments, process.steps]
  );
  // 有效排程以最近一次通过窗口校验的结果为准；失效时保留改动前结果，不写入半截时间。
  const activeSchedule = trialSchedule.valid ? trialSchedule : process.lastValidSchedule;
  const scheduleInvalid = !trialSchedule.valid;
  const conflictStepIds = new Set(trialSchedule.conflicts.map((conflict) => conflict.stepId).filter((id): id is string => Boolean(id)));
  const scheduleEntryMap = useMemo(() => new Map((activeSchedule?.entries ?? []).map((entry) => [entry.stepId, entry])), [activeSchedule]);
  const versionDiff = useMemo(() => compareVersions(process, compareBaseId, compareTargetId), [process, compareBaseId, compareTargetId]);
  const scheduleDiff = useMemo(() => {
    const base = process.versions.find((version) => version.id === compareBaseId);
    const target = process.versions.find((version) => version.id === compareTargetId);
    return compareScheduleEntries(
      base?.schedule,
      target?.schedule,
      base?.steps ?? [],
      target?.steps ?? []
    );
  }, [process.versions, compareBaseId, compareTargetId]);

  useEffect(() => {
    if (!initialSaveSkipped.current) {
      initialSaveSkipped.current = true;
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(process));
    setSavedLabel(`自动保存 · ${formatDate(new Date().toISOString())}`);
  }, [process]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? dispatch({ type: 'redo' }) : dispatch({ type: 'undo' });
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(process));
        setSavedLabel(`手动保存 · ${formatDate(new Date().toISOString())}`);
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [process]);

  const commitProcess = (update: (draft: ExperimentProcess) => void): void => {
    dispatch({ type: 'commit', update });
  };

  const updateProcessField = (field: 'title' | 'code' | 'objective' | 'principal' | 'lab', value: string): void => {
    commitProcess((draft) => { draft[field] = value; });
  };

  const updateStep = (field: keyof ProcessStep, value: unknown): void => {
    if (!selectedStep) return;
    const id = selectedStep.id;
    setLastModifiedId(id);
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (step) (step as unknown as Record<string, unknown>)[field] = value;
    });
  };

  const updateStepList = (field: 'hazards' | 'dependencies', value: string): void => {
    updateStep(field, splitList(value));
  };

  const addStep = (): void => {
    if (process.status === 'frozen') return;
    const id = uid('step');
    commitProcess((draft) => {
      draft.steps.push({
        id, title: '新的实验步骤', purpose: '', materials: '', equipment: '', amount: '', duration: 10,
        hazards: [], controls: '', dependencies: draft.steps.at(-1) ? [draft.steps.at(-1)!.id] : [],
        safetyNote: '', expectedResult: '', status: 'draft', comments: [],
        instrumentId: undefined, earliestStart: undefined
      });
      draft.status = 'draft';
    });
    setSelectedStepId(id);
    setLastModifiedId(id);
    setActiveView('editor');
  };

  const duplicateStep = (): void => {
    if (!selectedStep || process.status === 'frozen') return;
    const copy: ProcessStep = clone(selectedStep);
    copy.id = uid('step');
    copy.title = `${copy.title}（副本）`;
    copy.status = 'draft';
    copy.comments = [];
    copy.dependencies = [...copy.dependencies];
    commitProcess((draft) => {
      const index = draft.steps.findIndex((step) => step.id === selectedStep.id);
      draft.steps.splice(index + 1, 0, copy);
    });
    setSelectedStepId(copy.id);
  };

  const deleteStep = (): void => {
    if (!selectedStep || process.steps.length <= 1 || process.status === 'frozen') return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      draft.steps = draft.steps.filter((step) => step.id !== id);
      draft.steps.forEach((step) => { step.dependencies = step.dependencies.filter((dependency) => dependency !== id); });
    });
    setSelectedStepId(process.steps.find((step) => step.id !== id)?.id ?? '');
  };

  const moveStep = (direction: -1 | 1): void => {
    if (!selectedStep || process.status === 'frozen') return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      const index = draft.steps.findIndex((step) => step.id === id);
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= draft.steps.length) return;
      const [step] = draft.steps.splice(index, 1);
      draft.steps.splice(nextIndex, 0, step);
    });
    setLastModifiedId(id);
  };

  const toggleDependency = (dependencyId: string, checked: boolean): void => {
    if (!selectedStep) return;
    const next = checked
      ? [...new Set([...selectedStep.dependencies, dependencyId])]
      : selectedStep.dependencies.filter((id) => id !== dependencyId);
    updateStep('dependencies', next);
  };

  const submitForReview = (): void => {
    if (process.status === 'frozen') return;
    commitProcess((draft) => {
      draft.status = 'in-review';
      draft.steps.forEach((step) => {
        if (step.status !== 'confirmed') step.status = 'submitted';
      });
    });
    setActiveView('review');
    setSavedLabel('流程已提交复核');
  };

  const addReviewComment = (): void => {
    if (!selectedStep || !commentText.trim()) return;
    const id = selectedStep.id;
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      step?.comments.push({
        id: uid('comment'), author: CURRENT_AUTHOR, role: CURRENT_ROLE,
        text: commentText.trim(), createdAt: new Date().toISOString(), resolved: false
      });
    });
    setCommentText('');
  };

  const setStepStatus = (status: StepStatus): void => {
    if (!selectedStep) return;
    updateStep('status', status);
    setLastModifiedId(status === 'returned' ? selectedStep.id : null);
  };

  const resolveComment = (commentId: string): void => {
    if (!selectedStep) return;
    const stepId = selectedStep.id;
    commitProcess((draft) => {
      const comment = draft.steps.find((step) => step.id === stepId)?.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const freezeVersion = (): void => {
    if (process.status === 'frozen') return;
    if (process.steps.some((step) => step.status !== 'confirmed') || missingSafetySteps.length) {
      setSavedLabel('冻结条件未满足');
      return;
    }
    if (scheduleInvalid || !trialSchedule || trialSchedule.unscheduledStepIds.length > 0) {
      setSavedLabel('排程未全部生效，已拒绝冻结');
      setActiveView('schedule');
      return;
    }
    const nextNumber = nextMinorVersion(process.version);
    const previousVersionId = process.versions.at(-1)?.id ?? '';
    const frozenVersionId = uid('version');
    commitProcess((draft) => {
      const schedule = buildSchedule(draft.scheduleDate, draft.instruments, draft.steps);
      draft.versions.push({
        id: frozenVersionId, label: '复核通过冻结版', version: nextNumber,
        createdAt: new Date().toISOString(), note: `${draft.steps.length} 个步骤全部确认，安全控制完整，当天排程已生效。`,
        author: CURRENT_AUTHOR, steps: clone(draft.steps),
        instruments: clone(draft.instruments), scheduleDate: draft.scheduleDate,
        schedule: schedule.valid ? clone(schedule) : undefined
      });
      draft.version = nextNumber;
      draft.status = 'frozen';
      draft.frozenAt = new Date().toISOString();
    });
    setSavedLabel(`版本 ${nextNumber} 已冻结`);
    setCompareBaseId(previousVersionId);
    setCompareTargetId(frozenVersionId);
  };

  const startRevision = (): void => {
    if (process.status !== 'frozen') return;
    commitProcess((draft) => {
      const nextNumber = nextMinorVersion(draft.version);
      draft.version = `${nextNumber}-revision`;
      draft.status = 'revising';
      draft.frozenAt = undefined;
      draft.steps.forEach((step) => {
        step.status = 'draft';
        step.comments = [];
      });
    });
    setActiveView('editor');
    setSavedLabel('已从冻结版本创建修订稿');
  };

  const updateStepScheduleField = (field: 'instrumentId' | 'earliestStart', value: string): void => {
    if (!selectedStep) return;
    const id = selectedStep.id;
    setLastModifiedId(id);
    commitProcess((draft) => {
      const step = draft.steps.find((item) => item.id === id);
      if (!step) return;
      if (field === 'instrumentId') step.instrumentId = value || undefined;
      else step.earliestStart = value || undefined;
    });
  };

  const updateInstrument = (instrumentId: string, field: keyof Instrument, value: string | number): void => {
    if (process.status === 'frozen') return;
    commitProcess((draft) => {
      const instrument = draft.instruments.find((item) => item.id === instrumentId);
      if (instrument) (instrument as unknown as Record<string, string | number>)[field] = value;
    });
    setSavedLabel('仪器台账变更，排程已重算');
  };

  const addInstrument = (): void => {
    if (process.status === 'frozen') return;
    const id = uid('inst');
    commitProcess((draft) => {
      draft.instruments.push({ id, name: '新仪器', capacity: 1, workStart: '09:00', workEnd: '17:00' });
    });
    setSavedLabel('已新增仪器，请维护台数与工作时间');
  };

  const deleteInstrument = (instrumentId: string): void => {
    if (process.status === 'frozen') return;
    const usedBy = process.steps.filter((step) => step.instrumentId === instrumentId);
    commitProcess((draft) => {
      draft.instruments = draft.instruments.filter((instrument) => instrument.id !== instrumentId);
      draft.steps.forEach((step) => {
        if (step.instrumentId === instrumentId) step.instrumentId = undefined;
      });
    });
    setSavedLabel(usedBy.length ? `仪器已删除，${usedBy.length} 个步骤变为未排程` : '仪器已删除');
  };

  const updateScheduleDate = (value: string): void => {
    if (!value || process.status === 'frozen') return;
    commitProcess((draft) => {
      draft.scheduleDate = value;
      // 换天：不属于当天的不可早于时间不再约束排程，但保留原值以便切回。
    });
  };

  const useTodaySchedule = (): void => {
    updateScheduleDate(todayDateInput());
    setSavedLabel(`已切换到今天 ${todayDateInput()}，排程已重算`);
  };

  const addVersionSnapshot = (): void => {
    if (scheduleInvalid) {
      setSavedLabel('排程存在冲突，已拒绝写入版本快照');
      setActiveView('schedule');
      return;
    }
    commitProcess((draft) => {
      const schedule = buildSchedule(draft.scheduleDate, draft.instruments, draft.steps);
      const unscheduled = schedule.unscheduledStepIds.length;
      draft.versions.push({
        id: uid('version'), label: '工作版本快照', version: draft.version.replace('-draft', ''),
        createdAt: new Date().toISOString(),
        note: unscheduled ? `保存当前步骤与复核状态；${unscheduled} 个步骤未排程。` : '保存当前步骤、复核状态与当天排程。',
        author: CURRENT_AUTHOR, steps: clone(draft.steps),
        instruments: clone(draft.instruments), scheduleDate: draft.scheduleDate,
        schedule: schedule.valid ? clone(schedule) : undefined
      });
    });
    setSavedLabel('已保存工作版本快照');
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-icon"><Icon icon="lab-test" size={23} /></div>
          <div><h1>实验流程安全复核台</h1><p>步骤影响分析 · 当日仪器排程 · 逐条复核 · 冻结版本</p></div>
        </div>
        <div className="header-status">
          <span className={`network ${online ? 'online' : ''}`}></span>
          <span>{online ? '离线保存已启用' : '当前离线，修改仍会保存'}</span>
          <strong>{savedLabel}</strong>
        </div>
        <div className="header-actions">
          <Button icon="undo" text="撤销" minimal disabled={history.past.length === 0} onClick={() => dispatch({ type: 'undo' })} />
          <Button icon="redo" text="重做" minimal disabled={history.future.length === 0} onClick={() => dispatch({ type: 'redo' })} />
          <Button icon="floppy-disk" text="保存快照" onClick={addVersionSnapshot} />
          <Button icon="lock" text="冻结版本" intent="primary" onClick={freezeVersion} disabled={process.status === 'frozen'} />
        </div>
      </header>

      {!online && <Callout className="offline-callout" intent="warning" icon="cloud">网络不可用。编辑、复核和版本快照仍会保存在当前浏览器。</Callout>}

      <section className="process-banner">
        <div className="banner-main">
          <div className="code-line"><span>{process.code}</span><Tag minimal>{processStatusLabel(process.status)}</Tag></div>
          <h2>{process.title}</h2>
          <p>{process.objective}</p>
        </div>
        <div className="banner-meta">
          <div><span>负责人</span><strong>{process.principal}</strong></div>
          <div><span>实验区域</span><strong>{process.lab}</strong></div>
          <div><span>当前版本</span><strong>{process.version}</strong></div>
        </div>
        <div className="banner-progress">
          <div><span>复核进度</span><strong>{confirmedCount}/{process.steps.length}</strong></div>
          <ProgressBar value={reviewProgress / 100} intent={reviewProgress === 100 ? 'success' : 'primary'} stripes={reviewProgress < 100} />
          <small>{pendingReviewCount ? `${pendingReviewCount} 条待处理` : '所有步骤已处理'} · {missingSafetySteps.length} 条安全缺口</small>
        </div>
      </section>

      <Tabs id="workspace-tabs" selectedTabId={activeView} onChange={(value) => setActiveView(value as ViewId)} renderActiveTabPanelOnly className="workspace-tabs">
        <Tab id="editor" title={<span><Icon icon="edit" /> 流程编写</span>} />
        <Tab
          id="schedule"
          title={<span><Icon icon="time" /> 当天排程{scheduleInvalid ? <b className="tab-badge">!</b> : trialSchedule.unscheduledStepIds.length > 0 ? <b className="tab-badge tab-badge-muted">{trialSchedule.unscheduledStepIds.length}</b> : null}</span>}
        />
        <Tab id="review" title={<span><Icon icon="endorsed" /> 安全复核 {pendingReviewCount > 0 && <b className="tab-badge">{pendingReviewCount}</b>}</span>} />
        <Tab id="compare" title={<span><Icon icon="comparison" /> 版本比较</span>} />
      </Tabs>

      {activeView === 'editor' && selectedStep && (
        <main className="editor-layout">
          <aside className="step-panel">
            <div className="panel-heading">
              <div><span>PROCESS STEPS</span><h3>实验步骤</h3></div>
              <Button icon="add" minimal small onClick={addStep} disabled={process.status === 'frozen'} />
            </div>
            <div className="step-list">
              {process.steps.map((step, index) => (
                <button key={step.id} className={step.id === selectedStep.id ? 'selected' : ''} onClick={() => setSelectedStepId(step.id)}>
                  <span className={`step-number ${step.status}`}>{String(index + 1).padStart(2, '0')}</span>
                  <span className="step-copy"><strong>{step.title}</strong><small>{step.duration} 分钟 · {statusLabel(step.status)}</small></span>
                  {hasMissingSafety(step) && <Icon icon="warning-sign" intent="danger" size={13} />}
                </button>
              ))}
            </div>
            <div className="step-actions">
              <Button icon="arrow-up" small minimal disabled={process.steps[0]?.id === selectedStep.id || process.status === 'frozen'} onClick={() => moveStep(-1)} />
              <Button icon="arrow-down" small minimal disabled={process.steps.at(-1)?.id === selectedStep.id || process.status === 'frozen'} onClick={() => moveStep(1)} />
              <Button icon="duplicate" small minimal text="复制" disabled={process.status === 'frozen'} onClick={duplicateStep} />
              <Button icon="trash" small minimal intent="danger" disabled={process.status === 'frozen'} onClick={deleteStep} />
            </div>
          </aside>

          <section className="editor-main">
            <Card elevation={Elevation.ONE} className="process-meta-card">
              <div className="card-title"><div><span>PROCESS INFO</span><h3>实验基本信息</h3></div><Tag minimal intent="primary">{process.steps.length} 个步骤</Tag></div>
              <div className="meta-grid">
                <FormGroup label="实验名称" labelFor="process-title"><InputGroup id="process-title" fill value={process.title} onChange={(event) => updateProcessField('title', event.target.value)} /></FormGroup>
                <FormGroup label="流程编号" labelFor="process-code"><InputGroup id="process-code" fill value={process.code} onChange={(event) => updateProcessField('code', event.target.value)} /></FormGroup>
                <FormGroup label="负责人" labelFor="principal"><InputGroup id="principal" fill value={process.principal} onChange={(event) => updateProcessField('principal', event.target.value)} /></FormGroup>
                <FormGroup label="实验区域" labelFor="lab"><InputGroup id="lab" fill value={process.lab} onChange={(event) => updateProcessField('lab', event.target.value)} /></FormGroup>
              </div>
              <FormGroup label="实验目标" labelFor="objective"><TextArea id="objective" fill value={process.objective} onChange={(event) => updateProcessField('objective', event.target.value)} /></FormGroup>
            </Card>

            <Card elevation={Elevation.ONE} className="step-editor-card">
              <div className="card-title">
                <div><span>STEP {String(process.steps.indexOf(selectedStep) + 1).padStart(2, '0')}</span><h3>{selectedStep.title}</h3></div>
                <Tag minimal intent={selectedStep.status === 'confirmed' ? 'success' : selectedStep.status === 'returned' ? 'danger' : 'warning'}>{statusLabel(selectedStep.status)}</Tag>
              </div>
              <FormGroup label="步骤名称" labelFor="step-title"><InputGroup id="step-title" fill value={selectedStep.title} onChange={(event) => updateStep('title', event.target.value)} /></FormGroup>
              <FormGroup label="操作目的" labelFor="step-purpose"><TextArea id="step-purpose" fill value={selectedStep.purpose} onChange={(event) => updateStep('purpose', event.target.value)} /></FormGroup>
              <div className="form-grid">
                <FormGroup label="材料" labelFor="materials"><TextArea id="materials" fill value={selectedStep.materials} onChange={(event) => updateStep('materials', event.target.value)} /></FormGroup>
                <FormGroup label="设备" labelFor="equipment"><TextArea id="equipment" fill value={selectedStep.equipment} onChange={(event) => updateStep('equipment', event.target.value)} /></FormGroup>
                <FormGroup label="用量 / 参数" labelFor="amount"><TextArea id="amount" fill value={selectedStep.amount} onChange={(event) => updateStep('amount', event.target.value)} /></FormGroup>
                <FormGroup label="预计时间（分钟）" labelFor="duration"><InputGroup id="duration" type="number" min={1} fill value={String(selectedStep.duration)} onChange={(event) => updateStep('duration', Number(event.target.value))} /></FormGroup>
              </div>
              <div className="form-grid schedule-field-grid">
                <FormGroup label="排程仪器（决定台数与工作时间）" labelFor="step-instrument" helperText="不选仪器的步骤标记为未排程，不参与当天占用。">
                  <HTMLSelect
                    id="step-instrument" fill value={selectedStep.instrumentId ?? ''}
                    onChange={(event) => updateStepScheduleField('instrumentId', event.target.value)}
                  >
                    <option value="">（未选择 · 未排程）</option>
                    {process.instruments.map((instrument) => (
                      <option key={instrument.id} value={instrument.id}>{instrument.name} · {instrument.capacity} 台 · {instrument.workStart}–{instrument.workEnd}</option>
                    ))}
                  </HTMLSelect>
                </FormGroup>
                <FormGroup label="不可早于时间" labelFor="step-earliest" helperText={`仅约束排程当天 ${process.scheduleDate}；留空表示仅受前置步骤限制。`}>
                  <InputGroup
                    id="step-earliest" type="datetime-local" fill
                    value={selectedStep.earliestStart ?? ''}
                    onChange={(event) => updateStepScheduleField('earliestStart', event.target.value)}
                  />
                </FormGroup>
              </div>
              <div className="form-grid two-column">
                <FormGroup label="危险项（逗号或换行分隔）" labelFor="hazards"><TextArea id="hazards" fill value={selectedStep.hazards.join('，')} onChange={(event) => updateStepList('hazards', event.target.value)} /></FormGroup>
                <FormGroup label="控制措施" labelFor="controls"><TextArea id="controls" fill value={selectedStep.controls} onChange={(event) => updateStep('controls', event.target.value)} /></FormGroup>
              </div>
              <FormGroup label="安全说明" labelFor="safety-note" helperText={hasMissingSafety(selectedStep) ? '存在危险项时，控制措施和安全说明均为必填。' : '安全说明已满足复核条件。'}>
                <TextArea id="safety-note" fill intent={hasMissingSafety(selectedStep) ? 'danger' : 'none'} value={selectedStep.safetyNote} onChange={(event) => updateStep('safetyNote', event.target.value)} />
              </FormGroup>
              <FormGroup label="预期结果" labelFor="expected"><TextArea id="expected" fill value={selectedStep.expectedResult} onChange={(event) => updateStep('expectedResult', event.target.value)} /></FormGroup>
            </Card>

            <Card elevation={Elevation.ONE} className="dependency-card">
              <div className="card-title"><div><span>DEPENDENCIES</span><h3>前置步骤</h3></div><Tag minimal>{selectedStep.dependencies.length} 个依赖</Tag></div>
              <p className="muted">当前步骤只有在所选前置步骤完成后才能进入执行队列。</p>
              <div className="dependency-grid">
                {process.steps.filter((step) => step.id !== selectedStep.id).map((step) => (
                  <Checkbox key={step.id} checked={selectedStep.dependencies.includes(step.id)} label={`${String(process.steps.indexOf(step) + 1).padStart(2, '0')} · ${step.title}`} onChange={(event) => toggleDependency(step.id, event.currentTarget.checked)} />
                ))}
              </div>
            </Card>
          </section>

          <aside className="inspector-panel">
            <Card elevation={Elevation.ONE} className="impact-card">
              <div className="card-title"><div><span>IMPACT ANALYSIS</span><h3>变更影响提醒</h3></div><Icon icon="path-search" size={18} /></div>
              {lastModifiedId ? (
                <>
                  <Callout intent={impactedSteps.length ? 'warning' : 'primary'} icon={impactedSteps.length ? 'warning-sign' : 'tick'}>
                    <strong>{impactedSteps.length ? `${impactedSteps.length} 个后续步骤受影响` : '未发现下游步骤'}</strong>
                    <p>{impactedSteps.length ? '请重新核对依赖、用量、危险项和已确认内容。' : '当前修改没有影响其他步骤的安全条件。'}</p>
                  </Callout>
                  <div className="impact-list">
                    {impactedSteps.map((step) => (
                      <button key={step.id} onClick={() => setSelectedStepId(step.id)}>
                        <Icon icon={step.status === 'confirmed' ? 'endorsed' : 'circle'} intent={step.status === 'confirmed' ? 'success' : 'none'} size={13} />
                        <span><strong>{step.title}</strong><small>{step.status === 'confirmed' ? '已确认内容，需重新复核' : `当前状态：${statusLabel(step.status)}`}</small></span>
                        <Icon icon="chevron-right" size={12} />
                      </button>
                    ))}
                  </div>
                </>
              ) : <p className="muted">编辑任一步骤后，这里会显示受影响的所有后续步骤和已确认内容。</p>}
            </Card>

            <Card elevation={Elevation.ONE} className="safety-card">
              <div className="card-title"><div><span>SAFETY GATE</span><h3>安全完整性</h3></div><Tag intent={missingSafetySteps.length ? 'danger' : 'success'} minimal>{missingSafetySteps.length ? `${missingSafetySteps.length} 项缺口` : '通过'}</Tag></div>
              {missingSafetySteps.length ? missingSafetySteps.map((step) => (
                <button className="safety-row" key={step.id} onClick={() => setSelectedStepId(step.id)}><Icon icon="warning-sign" intent="danger" size={14} /><span><strong>{step.title}</strong><small>危险项缺少控制措施或安全说明</small></span></button>
              )) : <p className="muted">所有存在危险项的步骤都已填写控制措施和安全说明。</p>}
            </Card>

            <Card elevation={Elevation.ONE} className="gate-card">
              <div className="card-title"><div><span>RELEASE GATE</span><h3>提交与冻结</h3></div></div>
              <div className="gate-row"><span>复核状态</span><strong>{confirmedCount}/{process.steps.length}</strong></div>
              <div className="gate-row"><span>安全缺口</span><strong className={missingSafetySteps.length ? 'danger-text' : ''}>{missingSafetySteps.length}</strong></div>
              <div className="gate-row"><span>流程状态</span><strong>{processStatusLabel(process.status)}</strong></div>
              <Divider />
              {process.status === 'frozen' ? <Button fill intent="warning" icon="git-branch" text="从冻结版创建修订" onClick={startRevision} /> : <Button fill intent="primary" icon="send-to" text="提交复核" onClick={submitForReview} />}
            </Card>
          </aside>
        </main>
      )}

      {activeView === 'schedule' && (
        <main className="schedule-layout">
          <Card elevation={Elevation.ONE} className="instrument-card">
            <div className="card-title">
              <div><span>INSTRUMENTS</span><h3>仪器台账</h3></div>
              <Button icon="add" small minimal text="新增仪器" onClick={addInstrument} disabled={process.status === 'frozen'} />
            </div>
            <p className="muted">维护每台仪器的可用台数与当天工作时间；同一仪器并行占用不超过台数，步骤只能排在工作窗口内。</p>
            <div className="instrument-list">
              <div className="instrument-row instrument-head"><span>仪器</span><span>台数</span><span>上班</span><span>下班</span><span></span></div>
              {process.instruments.map((instrument) => {
                const gap = trialSchedule.gaps.find((item) => item.instrumentId === instrument.id);
                return (
                  <div className="instrument-row" key={instrument.id}>
                    <InputGroup fill small value={instrument.name} disabled={process.status === 'frozen'} onChange={(event) => updateInstrument(instrument.id, 'name', event.target.value)} placeholder="仪器名称" />
                    <NumericInput small fill min={1} max={20} value={instrument.capacity} disabled={process.status === 'frozen'} onValueChange={(value) => updateInstrument(instrument.id, 'capacity', Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1)} />
                    <InputGroup small type="time" value={instrument.workStart} disabled={process.status === 'frozen'} onChange={(event) => updateInstrument(instrument.id, 'workStart', event.target.value)} />
                    <InputGroup small type="time" value={instrument.workEnd} disabled={process.status === 'frozen'} onChange={(event) => updateInstrument(instrument.id, 'workEnd', event.target.value)} />
                    <Button small minimal icon="trash" intent="danger" disabled={process.status === 'frozen'} onClick={() => deleteInstrument(instrument.id)} />
                    {gap && <small className="instrument-gap">峰值并行 {gap.peakOverlap}/{gap.capacity} 台；窗口外缺口 {gap.shortfall} 分钟</small>}
                  </div>
                );
              })}
              {!process.instruments.length && <p className="muted">尚无仪器，请新增仪器并维护台数与工作时间。</p>}
            </div>
          </Card>

          <Card elevation={Elevation.ONE} className="timeline-card">
            <div className="card-title">
              <div><span>SCHEDULE DATE · {process.scheduleDate}</span><h3>当天排程时间线</h3></div>
              <div className="schedule-date-controls">
                <InputGroup type="date" small value={process.scheduleDate} onChange={(event) => updateScheduleDate(event.target.value)} disabled={process.status === 'frozen'} />
                <Button small minimal icon="calendar" text="回到今天" onClick={useTodaySchedule} disabled={process.status === 'frozen'} />
              </div>
            </div>

            {scheduleInvalid && (
              <Callout intent="danger" icon="warning-sign" className="schedule-conflict-callout" title="排程已失效：改动已保留，但不会写入版本快照，也不允许冻结">
                <p>系统按最新输入重算后无法在当天窗口内完成。下表时间线为试算结果（红色为越界步骤），改动前的有效排程仍保留：{activeSchedule ? `截至 ${formatClock(activeSchedule.windowStart)}–${formatClock(activeSchedule.windowEnd)} 的版本` : '本次会话尚无有效排程'}。</p>
                <ul className="conflict-list">
                  {trialSchedule.conflicts.map((conflict, index) => {
                    const step = process.steps.find((item) => item.id === conflict.stepId);
                    return (
                      <li key={`${conflict.reason}-${conflict.stepId ?? conflict.instrumentId ?? index}`}>
                        <Tag minimal intent="danger">{conflictLabel(conflict.reason)}</Tag>
                        <button className="conflict-step-link" disabled={!step} onClick={() => step && (setSelectedStepId(step.id), setActiveView('editor'))}>{step ? step.title : '仪器台账'}</button>
                        <span>{conflict.message}</span>
                        {typeof conflict.overflow === 'number' && conflict.overflow > 0 && <strong>缺口 {Math.round(conflict.overflow)} 分钟</strong>}
                      </li>
                    );
                  })}
                </ul>
                {trialSchedule.gaps.length > 0 && (
                  <div className="gap-box">
                    {trialSchedule.gaps.map((gap) => (
                      <span key={gap.instrumentId}><strong>{gap.instrumentName}</strong>：{gap.capacity} 台，峰值并行 {gap.peakOverlap} 台，容量缺口 {gap.shortfall} 分钟（需加班、增台或削减任务）。</span>
                    ))}
                  </div>
                )}
              </Callout>
            )}
            {!scheduleInvalid && trialSchedule.unscheduledStepIds.length > 0 && (
              <Callout intent="warning" icon="time" className="schedule-conflict-callout" title={`${trialSchedule.unscheduledStepIds.length} 个步骤未排程`}>
                <p>以下步骤未选择仪器，不占用当天容量；全部步骤排程生效后才能冻结版本。</p>
                <ul className="conflict-list">
                  {trialSchedule.unscheduledStepIds.map((id) => {
                    const step = process.steps.find((item) => item.id === id);
                    return (
                      <li key={id}>
                        <Tag minimal intent="warning">未排程</Tag>
                        <button className="conflict-step-link" onClick={() => { if (step) { setSelectedStepId(step.id); setActiveView('editor'); } }}>{step?.title ?? id}</button>
                        <span>请在流程编写中为该步骤选择仪器。</span>
                      </li>
                    );
                  })}
                </ul>
              </Callout>
            )}
            {!scheduleInvalid && trialSchedule.unscheduledStepIds.length === 0 && (
              <Callout intent="success" icon="tick-circle" className="schedule-conflict-callout" title={`排程有效 · 所有步骤均可在 ${process.scheduleDate} 的仪器窗口内完成`}>
                <p>开始、结束与等待时长均由依赖关系、不可早于时间和仪器台数自动推算；任一输入变化会立即重算。</p>
              </Callout>
            )}

            <ScheduleGantt
              instruments={process.instruments}
              schedule={trialSchedule}
              selectedStepId={selectedStep?.id ?? ''}
              onSelectStep={(id) => { setSelectedStepId(id); }}
              conflictStepIds={conflictStepIds}
            />
          </Card>

          <Card elevation={Elevation.ONE} className="schedule-table-card">
            <div className="card-title"><div><span>STEP TIMES</span><h3>步骤排程明细</h3></div><Tag minimal intent={scheduleInvalid ? 'danger' : trialSchedule.unscheduledStepIds.length ? 'warning' : 'success'}>{scheduleInvalid ? '已失效' : trialSchedule.unscheduledStepIds.length ? '部分未排程' : '已生效'}</Tag></div>
            <div className="schedule-table">
              <div className="schedule-row schedule-head"><span>步骤</span><span>仪器</span><span>开始</span><span>结束</span><span>等待</span><span>状态</span></div>
              {process.steps.map((step, index) => {
                const entry = scheduleEntryMap.get(step.id);
                const isConflict = conflictStepIds.has(step.id);
                const unscheduled = !entry || trialSchedule.unscheduledStepIds.includes(step.id);
                const instrument = process.instruments.find((item) => item.id === step.instrumentId);
                return (
                  <button
                    key={step.id}
                    className={`schedule-row ${step.id === selectedStep?.id ? 'selected' : ''} ${isConflict ? 'conflict' : ''} ${unscheduled ? 'unscheduled' : ''}`}
                    onClick={() => setSelectedStepId(step.id)}
                  >
                    <span><b>{String(index + 1).padStart(2, '0')}</b> {step.title}</span>
                    <span>{instrument?.name ?? '—'}</span>
                    <span className="mono">{entry ? formatClock(entry.start) : '—'}</span>
                    <span className="mono">{entry ? formatClock(entry.end) : '—'}</span>
                    <span className="mono">{entry && entry.wait > 0 ? `${entry.wait} 分` : entry ? '0 分' : '—'}</span>
                    <span>{isConflict ? <Tag minimal intent="danger">冲突</Tag> : unscheduled ? <Tag minimal intent="warning">未排程</Tag> : <Tag minimal intent="success">已排入</Tag>}</span>
                  </button>
                );
              })}
            </div>
            <p className="muted" style={{ marginTop: 10 }}>
              {scheduleInvalid
                ? '排程失效期间冻结与版本快照均被拒绝，改动前的有效排程继续保留，避免半截时间进入版本。'
                : activeSchedule
                  ? `当前生效排程版本：${activeSchedule.entries.length} 个步骤，窗口 ${formatClock(activeSchedule.windowStart)}–${formatClock(activeSchedule.windowEnd)}。`
                  : '尚无生效排程。'}
            </p>
          </Card>
        </main>
      )}

      {activeView === 'review' && (
        <main className="review-layout">
          <aside className="review-steps">
            <div className="panel-heading"><div><span>REVIEW QUEUE</span><h3>逐条复核</h3></div><Tag intent={pendingReviewCount ? 'warning' : 'success'}>{pendingReviewCount ? `${pendingReviewCount} 待处理` : '已完成'}</Tag></div>
            {process.steps.map((step, index) => (
              <button key={step.id} className={`${step.id === selectedStep.id ? 'selected' : ''} ${step.status}`} onClick={() => setSelectedStepId(step.id)}>
                <span>{String(index + 1).padStart(2, '0')}</span><div><strong>{step.title}</strong><small>{statusLabel(step.status)}</small></div><Icon icon={step.status === 'confirmed' ? 'tick-circle' : step.status === 'returned' ? 'undo' : 'circle'} size={15} />
              </button>
            ))}
          </aside>
          <section className="review-main">
            {selectedStep && (
              <>
                <Card elevation={Elevation.ONE} className="review-summary">
                  <div className="card-title"><div><span>SAFETY REVIEW</span><h3>{selectedStep.title}</h3></div><Tag intent={selectedStep.status === 'confirmed' ? 'success' : selectedStep.status === 'returned' ? 'danger' : 'warning'}>{statusLabel(selectedStep.status)}</Tag></div>
                  <div className="review-facts">
                    <div><span>预计时间</span><strong>{selectedStep.duration} 分钟</strong></div>
                    <div><span>材料与用量</span><strong>{selectedStep.materials} / {selectedStep.amount}</strong></div>
                    <div><span>危险项</span><strong>{selectedStep.hazards.join('、') || '无'}</strong></div>
                  </div>
                  <div className="review-section"><h4>控制措施</h4><p>{selectedStep.controls || '未填写'}</p></div>
                  <div className="review-section"><h4>安全说明</h4><p className={hasMissingSafety(selectedStep) ? 'danger-text' : ''}>{selectedStep.safetyNote || '未填写'}</p></div>
                  {hasMissingSafety(selectedStep) && <Callout intent="danger" icon="warning-sign">当前步骤存在安全信息缺口，不能确认或冻结版本。</Callout>}
                </Card>
                <Card elevation={Elevation.ONE} className="comment-card">
                  <div className="card-title"><div><span>REVIEW COMMENTS</span><h3>复核批注</h3></div><Tag minimal>{selectedStep.comments.length} 条</Tag></div>
                  <div className="comment-compose">
                    <TextArea fill value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="填写具体依据、风险或修改建议…" />
                    <Button intent="primary" icon="comment" text="添加批注" disabled={!commentText.trim()} onClick={addReviewComment} />
                  </div>
                  <div className="comment-list">
                    {selectedStep.comments.map((comment) => (
                      <article key={comment.id} className={comment.resolved ? 'resolved' : ''}>
                        <div className="comment-avatar">{comment.author.slice(0, 1)}</div>
                        <div><header><strong>{comment.author}</strong><span>{comment.role}</span><time>{formatDate(comment.createdAt)}</time></header><p>{comment.text}</p><Button minimal small text={comment.resolved ? '已解决' : '标记解决'} icon={comment.resolved ? 'tick' : 'circle'} onClick={() => resolveComment(comment.id)} /></div>
                      </article>
                    ))}
                    {!selectedStep.comments.length && <p className="muted">当前步骤尚未添加复核批注。</p>}
                  </div>
                </Card>
              </>
            )}
          </section>
          <aside className="review-actions">
            <Card elevation={Elevation.ONE}>
              <div className="card-title"><div><span>REVIEWER ACTION</span><h3>复核决定</h3></div><Icon icon="endorsed" size={18} /></div>
              <p className="muted">确认后若修改该步骤，受影响的下游步骤会在编辑页重新提示。</p>
              <Button fill large intent="success" icon="tick" text="逐条确认" disabled={hasMissingSafety(selectedStep)} onClick={() => setStepStatus('confirmed')} />
              <Button fill large icon="undo" text="退回修改" intent="warning" onClick={() => setStepStatus('returned')} />
              <Button fill large minimal icon="refresh" text="恢复为待复核" onClick={() => setStepStatus('submitted')} />
              <Divider />
              <div className="review-progress-list">
                {process.steps.map((step) => <div key={step.id}><span>{step.title}</span><Tag minimal intent={step.status === 'confirmed' ? 'success' : step.status === 'returned' ? 'danger' : 'warning'}>{statusLabel(step.status)}</Tag></div>)}
              </div>
              <Button fill intent="primary" icon="lock" text="全部确认后冻结" onClick={freezeVersion} disabled={process.status === 'frozen'} />
            </Card>
          </aside>
        </main>
      )}

      {activeView === 'compare' && (
        <main className="compare-layout">
          <Card elevation={Elevation.ONE} className="version-panel">
            <div className="card-title"><div><span>VERSION TIMELINE</span><h3>冻结版本</h3></div><Tag minimal>{process.versions.length} 个</Tag></div>
            <div className="version-timeline">
              {process.versions.map((version, index) => (
                <article key={version.id} className={index === process.versions.length - 1 ? 'latest' : ''}>
                  <span></span><div><b>{version.version}</b><strong>{version.label}</strong><p>{formatDate(version.createdAt)} · {version.steps.length} 个步骤 · {version.author}</p>
                    <Tag minimal intent={version.schedule?.valid ? 'success' : 'none'} icon="time">{version.schedule?.valid ? `排程 ${version.scheduleDate} · ${version.schedule.entries.length} 步已排入` : '未排程（旧版本）'}</Tag>
                    <small>{version.note}</small></div>
                </article>
              ))}
            </div>
          </Card>
          <Card elevation={Elevation.ONE} className="diff-panel">
            <div className="card-title"><div><span>VERSION DIFF</span><h3>流程差异比较</h3></div><div className="diff-selects">
              <HTMLSelect value={compareBaseId} onChange={(event) => setCompareBaseId(event.target.value)}>{process.versions.map((version) => <option key={version.id} value={version.id}>{version.version} · 基准</option>)}</HTMLSelect>
              <Icon icon="arrow-right" />
              <HTMLSelect value={compareTargetId} onChange={(event) => setCompareTargetId(event.target.value)}>{process.versions.map((version) => <option key={version.id} value={version.id}>{version.version} · 目标</option>)}</HTMLSelect>
            </div></div>
            <div className="diff-table">
              <div className="diff-head"><span>变更类型</span><span>步骤</span><span>具体内容</span></div>
              {versionDiff.map((diff) => <div className={`diff-row ${diff.kind}`} key={diff.id}><Tag minimal intent={diff.kind === 'added' ? 'success' : diff.kind === 'removed' ? 'danger' : 'primary'}>{diff.kind === 'added' ? '新增' : diff.kind === 'removed' ? '删除' : '修改'}</Tag><strong>{diff.title}</strong><p>{diff.detail}</p></div>)}
              {!versionDiff.length && <div className="empty-diff"><Icon icon="comparison" size={30} /><strong>两个版本没有差异</strong><p>请选择不同版本，或先冻结新的流程版本。</p></div>}
            </div>

            <div className="schedule-diff-title"><span>SCHEDULE DIFF</span><h4>排程比较 · 仪器 / 开始 / 结束 / 等待</h4></div>
            <div className="schedule-diff-table">
              <div className="schedule-diff-head"><span>步骤</span><span>基准仪器</span><span>开始</span><span>结束</span><span>等待</span><span></span><span>目标仪器</span><span>开始</span><span>结束</span><span>等待</span></div>
              {scheduleDiff.map((row) => (
                <div className={`schedule-diff-row ${row.changed ? 'changed' : ''}`} key={row.id}>
                  <span title={row.title}>{row.title}</span>
                  <span>{row.base ? row.base.instrumentName : <em>未排程</em>}</span>
                  <span className="mono">{row.base ? formatClock(row.base.start) : '—'}</span>
                  <span className="mono">{row.base ? formatClock(row.base.end) : '—'}</span>
                  <span className="mono">{row.base ? `${row.base.wait}′` : '—'}</span>
                  <Icon icon={row.changed ? 'arrow-right' : 'minus'} size={12} />
                  <span>{row.target ? row.target.instrumentName : <em>未排程</em>}</span>
                  <span className="mono">{row.target ? formatClock(row.target.start) : '—'}</span>
                  <span className="mono">{row.target ? formatClock(row.target.end) : '—'}</span>
                  <span className="mono">{row.target ? `${row.target.wait}′` : '—'}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card elevation={Elevation.ONE} className="freeze-rules">
            <div className="card-title"><div><span>FREEZE RULES</span><h3>冻结检查</h3></div></div>
            <div className={confirmedCount === process.steps.length ? 'passed' : ''}><Icon icon={confirmedCount === process.steps.length ? 'tick-circle' : 'circle'} /><span><strong>所有步骤已确认</strong><small>{confirmedCount}/{process.steps.length}</small></span></div>
            <div className={!missingSafetySteps.length ? 'passed' : ''}><Icon icon={!missingSafetySteps.length ? 'tick-circle' : 'circle'} /><span><strong>安全信息完整</strong><small>{missingSafetySteps.length} 个缺口</small></span></div>
            <div className={process.steps.every((step) => step.dependencies.every((id) => process.steps.some((item) => item.id === id))) ? 'passed' : ''}><Icon icon="git-merge" /><span><strong>依赖引用有效</strong><small>{process.steps.reduce((sum, step) => sum + step.dependencies.length, 0)} 条依赖</small></span></div>
            <div className={!scheduleInvalid && trialSchedule.unscheduledStepIds.length === 0 ? 'passed' : ''}>
              <Icon icon={!scheduleInvalid && trialSchedule.unscheduledStepIds.length === 0 ? 'tick-circle' : 'circle'} />
              <span><strong>当天排程全部生效</strong><small>{scheduleInvalid ? '排程冲突，已拒绝冻结' : trialSchedule.unscheduledStepIds.length ? `${trialSchedule.unscheduledStepIds.length} 个步骤未排程` : '窗口容量满足，开始/结束/等待已计算'}</small></span>
            </div>
            <Button fill intent="primary" icon="lock" text="冻结当前版本" onClick={freezeVersion} disabled={process.status === 'frozen' || confirmedCount !== process.steps.length || missingSafetySteps.length > 0 || scheduleInvalid || trialSchedule.unscheduledStepIds.length > 0} />
          </Card>
        </main>
      )}

      <footer className="app-footer">
        <span>所有实验数据仅保存在当前浏览器 localStorage。</span>
        <span>Ctrl/Cmd + Z 撤销 · Ctrl/Cmd + Y 重做 · Ctrl/Cmd + S 保存</span>
      </footer>
    </div>
  );
}

function hasMissingSafety(step: ProcessStep): boolean {
  return step.hazards.length > 0 && (!step.controls.trim() || !step.safetyNote.trim());
}

function collectDownstream(steps: ProcessStep[], sourceId: string | null): string[] {
  if (!sourceId) return [];
  const result = new Set<string>();
  const visit = (id: string) => {
    steps.filter((step) => step.dependencies.includes(id)).forEach((step) => {
      if (result.has(step.id)) return;
      result.add(step.id);
      visit(step.id);
    });
  };
  visit(sourceId);
  return [...result];
}

function nextMinorVersion(value: string): string {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '1.2.0';
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

function compareVersions(process: ExperimentProcess, baseId: string, targetId: string): DiffItem[] {
  const base = process.versions.find((version) => version.id === baseId);
  const target = process.versions.find((version) => version.id === targetId);
  if (!base || !target) return [];
  const diffs: DiffItem[] = [];
  const targetMap = new Map(target.steps.map((step) => [step.id, step]));
  const baseMap = new Map(base.steps.map((step) => [step.id, step]));
  base.steps.forEach((step) => {
    if (!targetMap.has(step.id)) diffs.push({ id: step.id, title: step.title, kind: 'removed', detail: '目标版本已删除该步骤。' });
  });
  target.steps.forEach((step) => {
    const before = baseMap.get(step.id);
    if (!before) {
      diffs.push({ id: step.id, title: step.title, kind: 'added', detail: `${step.duration} 分钟；危险项：${step.hazards.join('、') || '无'}` });
      return;
    }
    const fields: string[] = [];
    if (before.title !== step.title) fields.push('名称');
    if (before.purpose !== step.purpose) fields.push('目的');
    if (before.materials !== step.materials || before.amount !== step.amount) fields.push('材料或用量');
    if (before.equipment !== step.equipment) fields.push('设备');
    if (before.instrumentId !== step.instrumentId) fields.push('排程仪器');
    if (before.earliestStart !== step.earliestStart) fields.push('不可早于时间');
    if (before.duration !== step.duration) fields.push('预计时间');
    if (JSON.stringify(before.hazards) !== JSON.stringify(step.hazards)) fields.push('危险项');
    if (before.controls !== step.controls || before.safetyNote !== step.safetyNote) fields.push('安全控制');
    if (JSON.stringify(before.dependencies) !== JSON.stringify(step.dependencies)) fields.push('依赖关系');
    if (before.expectedResult !== step.expectedResult) fields.push('预期结果');
    if (fields.length) diffs.push({ id: step.id, title: step.title, kind: 'changed', detail: `变化字段：${fields.join('、')}。` });
  });
  return diffs;
}

export default App;
