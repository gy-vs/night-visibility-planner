import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Block,
  ComputeResult,
  Plan,
  SavePlanResponse,
  Site,
  Target,
} from '../../shared/types';
import { api, newBlockId } from '../api';
import { statusForBlocks, type BlockStatus } from '../../shared/validation';
import { isValidTimezone, todayInZone } from '../format';

const STORAGE_KEY = 'nwb.settings.v1';
const DEFAULT_SUN_ALT = -18;
const CLIENT_TOLERANCE_MS = 5 * 60 * 1000; // 与服务端容差一致

export type ConflictState =
  | { kind: 'none' }
  | { kind: 'saving' }
  | { kind: 'saved'; atUtc: string; version: number }
  | { kind: 'constraints'; messages: { blockId: string; message: string }[] }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; serverPlan: Plan; message: string };

interface PersistedSettings {
  siteId?: string;
  localDate?: string;
  timezone?: string;
  sunMaxAltitudeDeg?: number;
  targets?: Target[];
  selectedTargetId?: string | null;
}

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedSettings) : {};
  } catch {
    return {};
  }
}

function targetsHash(targets: Target[]): string {
  return JSON.stringify(
    targets
      .map((t) => [
        t.id,
        +t.raHours.toFixed(6),
        +t.decDeg.toFixed(6),
        +t.minAltitudeDeg.toFixed(3),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

function blocksSignature(blocks: Block[]): string {
  return JSON.stringify(
    blocks
      .map((b) => [b.id, b.targetId, b.start, b.end])
      .sort((a, b) => a[2].localeCompare(b[2])),
  );
}

export interface Workbench {
  sites: Site[];
  siteId: string;
  localDate: string;
  timezone: string;
  sunMaxAltitudeDeg: number;
  targets: Target[];
  selectedTargetId: string | null;

  compute: ComputeResult | null;
  computeLoading: boolean;
  computeError: string | null;
  /** 当前展示的计算结果是否对应最新条件（防止晚到结果冒名顶替） */
  computeStale: boolean;

  blocks: Block[];
  version: number;
  savedPlan: Plan | null;
  dirty: boolean;
  saveState: ConflictState;

  blockStatus: Map<string, BlockStatus>;
  selectedBlockId: string | null;

  setSite: (site: Site) => void;
  setNight: (patch: { localDate?: string; timezone?: string }) => void;
  setSunMax: (v: number) => void;
  setTargets: (t: Target[]) => void;
  setSelectedTarget: (id: string | null) => void;
  selectBlock: (id: string | null) => void;

  addTarget: (t: Omit<Target, 'id'>) => void;
  updateTarget: (id: string, patch: Partial<Omit<Target, 'id'>>) => void;
  removeTarget: (id: string) => void;

  addBlock: (targetId: string, startIso: string, minutes?: number) => void;
  updateBlock: (id: string, patch: Partial<Pick<Block, 'start' | 'end'>>) => void;
  removeBlock: (id: string) => void;

  save: () => Promise<void>;
  adoptServerPlan: () => void;
  dismissSaveState: () => void;
}

export function useWorkbench(): Workbench {
  const persisted = useRef<PersistedSettings>(loadSettings());
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string>(persisted.current.siteId ?? '');
  const [timezone, setTimezone] = useState<string>(
    persisted.current.timezone ?? 'Asia/Shanghai',
  );
  const [localDate, setLocalDate] = useState<string>(
    persisted.current.localDate ?? todayInZone(timezone),
  );
  const [sunMaxAltitudeDeg, setSunMaxState] = useState<number>(
    persisted.current.sunMaxAltitudeDeg ?? DEFAULT_SUN_ALT,
  );
  const [targets, setTargetsState] = useState<Target[]>(
    persisted.current.targets ?? [],
  );
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(
    persisted.current.selectedTargetId ?? null,
  );

  const [compute, setCompute] = useState<ComputeResult | null>(null);
  const [computeLoading, setComputeLoading] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [computeStale, setComputeStale] = useState(false);

  const [savedPlan, setSavedPlan] = useState<Plan | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [version, setVersion] = useState(0);
  const [saveState, setSaveState] = useState<ConflictState>({ kind: 'none' });
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // 已保存快照，用于脏状态判断
  const savedSig = useRef<string>('');
  // 最新计算请求序号，丢弃晚到响应
  const computeSeq = useRef(0);
  const nightIdentity = `${siteId}|${localDate}|${timezone}`;

  // ---------- 初始站点 ----------
  useEffect(() => {
    api.listSites().then(({ sites: list }) => {
      setSites(list);
      setSiteId((cur) => {
        if (cur && list.some((s) => s.id === cur)) return cur;
        const first = list[0];
        if (first) {
          setTimezone((tz) =>
            isValidTimezone(tz) ? tz : first.defaultTimezone,
          );
          return first.id;
        }
        return cur;
      });
    });
  }, []);

  // ---------- 持久化界面设置（不保存块：块以服务器为准） ----------
  useEffect(() => {
    const settings: PersistedSettings = {
      siteId,
      localDate,
      timezone,
      sunMaxAltitudeDeg,
      targets,
      selectedTargetId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [siteId, localDate, timezone, sunMaxAltitudeDeg, targets, selectedTargetId]);

  // ---------- 切换夜：重新载入该夜的服务端计划 ----------
  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;
    api.planByNight(siteId, localDate, timezone).then(({ plan }) => {
      if (cancelled) return;
      applyServerPlan(plan, { replaceTargets: true });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nightIdentity, siteId]);

  function applyServerPlan(plan: Plan | null, opts?: { replaceTargets?: boolean }) {
    setSavedPlan(plan);
    setVersion(plan?.version ?? 0);
    setBlocks(plan?.blocks ?? []);
    savedSig.current = plan
      ? JSON.stringify({
          blocks: blocksSignature(plan.blocks),
          targets: targetsHash(plan.targets),
          sun: plan.sunMaxAltitudeDeg,
        })
      : '';
    if (opts?.replaceTargets && plan && plan.targets.length > 0) {
      setTargetsState(plan.targets);
      setSelectedTargetId((cur) =>
        cur && plan.targets.some((t) => t.id === cur)
          ? cur
          : (plan.targets[0]?.id ?? null),
      );
    }
    setSaveState({ kind: 'none' });
  }

  // ---------- 条件变化 → 服务端权威计算（防抖 + 序号防晚到） ----------
  const hash = targetsHash(targets);
  useEffect(() => {
    if (!siteId) return;
    const seq = ++computeSeq.current;
    setComputeStale(true);
    if (targets.length === 0) {
      setCompute(null);
      setComputeError(null);
      setComputeLoading(false);
      setComputeStale(false);
      return;
    }
    setComputeLoading(true);
    setComputeError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .compute(
          {
            requestId: `c${seq}`,
            siteId,
            localDate,
            timezone,
            sunMaxAltitudeDeg,
            targets,
          },
          controller.signal,
        )
        .then((result) => {
          // 只有最新请求的结果可以落到界面
          if (seq !== computeSeq.current) return;
          setCompute(result);
          setComputeLoading(false);
          setComputeStale(false);
        })
        .catch((err: unknown) => {
          if (seq !== computeSeq.current) return;
          if (controller.signal.aborted) return;
          setComputeError(err instanceof Error ? err.message : String(err));
          setComputeLoading(false);
          setComputeStale(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, localDate, timezone, sunMaxAltitudeDeg, hash]);

  // ---------- 脏状态 ----------
  const currentSig = useMemo(
    () =>
      JSON.stringify({
        blocks: blocksSignature(blocks),
        targets: targetsHash(targets),
        sun: sunMaxAltitudeDeg,
      }),
    [blocks, targets, sunMaxAltitudeDeg],
  );
  // 已有保存快照：块或目标或太阳阈值与快照不同即为脏；
  // 尚无快照（新夜）：有未保存块即为脏
  const isDirty = savedSig.current
    ? currentSig !== savedSig.current
    : blocks.length > 0;

  // ---------- 块的即时校验状态 ----------
  const blockStatus = useMemo(() => {
    const wm = new Map<string, import('../../shared/types').UtcInterval[]>();
    if (compute) {
      for (const r of Object.values(compute.targets)) {
        wm.set(r.targetId, r.observableIntervals);
      }
      return statusForBlocks(blocks, targets, wm, CLIENT_TOLERANCE_MS);
    }
    return new Map<string, BlockStatus>();
  }, [compute, blocks, targets]);

  // ---------- 操作 ----------
  const guardDirty = useCallback((): boolean => {
    if (!isDirty) return true;
    return window.confirm(
      '当前夜晚有尚未保存的修改，切换后将放弃这些工作区改动（服务器上已保存的内容不受影响）。确定继续？',
    );
  }, [isDirty]);

  const setSite = useCallback(
    (site: Site) => {
      if (site.id === siteId) return;
      if (!guardDirty()) return;
      setSiteId(site.id);
      setTimezone(site.defaultTimezone);
    },
    [siteId, guardDirty],
  );

  const setNight = useCallback(
    (patch: { localDate?: string; timezone?: string }) => {
      const nextDate = patch.localDate ?? localDate;
      const nextTz = patch.timezone ?? timezone;
      if (nextDate === localDate && nextTz === timezone) return;
      if (!isValidTimezone(nextTz)) return;
      if (!guardDirty()) return;
      setLocalDate(nextDate);
      setTimezone(nextTz);
      setSelectedBlockId(null);
    },
    [localDate, timezone, guardDirty],
  );

  const setSunMax = useCallback((v: number) => setSunMaxState(v), []);

  const setTargets = useCallback((t: Target[]) => setTargetsState(t), []);

  const addTarget = useCallback((t: Omit<Target, 'id'>) => {
    const id = `tgt-${Math.random().toString(36).slice(2, 9)}`;
    setTargetsState((prev) => [...prev, { ...t, id }]);
    setSelectedTargetId(id);
  }, []);

  const updateTarget = useCallback(
    (id: string, patch: Partial<Omit<Target, 'id'>>) => {
      setTargetsState((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
    },
    [],
  );

  const removeTarget = useCallback((id: string) => {
    setTargetsState((prev) => prev.filter((t) => t.id !== id));
    setBlocks((prev) => prev.filter((b) => b.targetId !== id));
    setSelectedTargetId((cur) => (cur === id ? null : cur));
  }, []);

  const addBlock = useCallback(
    (targetId: string, startIso: string, minutes = 30) => {
      const start = Date.parse(startIso);
      const endIso = new Date(start + minutes * 60_000).toISOString();
      setBlocks((prev) => [
        ...prev,
        { id: newBlockId(), targetId, start: startIso, end: endIso },
      ]);
      setSaveState({ kind: 'none' });
    },
    [],
  );

  const updateBlock = useCallback(
    (id: string, patch: Partial<Pick<Block, 'start' | 'end'>>) => {
      setBlocks((prev) =>
        prev.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      );
      setSaveState({ kind: 'none' });
    },
    [],
  );

  const removeBlock = useCallback((id: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== id));
    setSelectedBlockId((cur) => (cur === id ? null : cur));
  }, []);

  // ---------- 保存 ----------
  const save = useCallback(async () => {
    if (!siteId) return;
    setSaveState({ kind: 'saving' });
    let response: SavePlanResponse;
    try {
      response = await api.savePlan({
        expectedVersion: version,
        siteId,
        localDate,
        timezone,
        sunMaxAltitudeDeg,
        targets,
        blocks,
      });
    } catch (err) {
      setSaveState({
        kind: 'error',
        message: `保存请求失败（网络/服务器错误），工作区修改未丢失：${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return;
    }

    if (response.ok) {
      applyServerPlan(response.plan, { replaceTargets: false });
      setSaveState({
        kind: 'saved',
        atUtc: response.plan.updatedAtUtc,
        version: response.plan.version,
      });
      return;
    }
    if (response.status === 409) {
      setSaveState({
        kind: 'conflict',
        serverPlan: response.serverPlan,
        message: response.message,
      });
      return;
    }
    if (response.status === 422) {
      setSaveState({
        kind: 'constraints',
        messages: response.conflicts.map((c) => ({
          blockId: c.blockId,
          message: c.message,
        })),
      });
      return;
    }
    setSaveState({ kind: 'error', message: response.message });
  }, [siteId, version, localDate, timezone, sunMaxAltitudeDeg, targets, blocks]);

  const adoptServerPlan = useCallback(() => {
    if (saveState.kind !== 'conflict') return;
    applyServerPlan(saveState.serverPlan, { replaceTargets: true });
    setSelectedBlockId(null);
  }, [saveState]);

  const dismissSaveState = useCallback(
    () => setSaveState({ kind: 'none' }),
    [],
  );

  return {
    sites,
    siteId,
    localDate,
    timezone,
    sunMaxAltitudeDeg,
    targets,
    selectedTargetId,
    compute,
    computeLoading,
    computeError,
    computeStale,
    blocks,
    version,
    savedPlan,
    dirty: isDirty,
    saveState,
    blockStatus,
    selectedBlockId,
    setSite,
    setNight,
    setSunMax,
    setTargets,
    setSelectedTarget: setSelectedTargetId,
    addTarget,
    updateTarget,
    removeTarget,
    addBlock,
    updateBlock,
    removeBlock,
    selectBlock: setSelectedBlockId,
    save,
    adoptServerPlan,
    dismissSaveState,
  };
}
