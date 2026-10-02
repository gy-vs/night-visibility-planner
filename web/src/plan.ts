import type { Block, NightResult } from './types';

/** An editable block. `id` is set once the server has confirmed it. */
export interface BlockDraft {
  clientId: string;
  id?: string;
  targetId: string;
  startUtc: number;
  endUtc: number;
  note: string;
}

let seq = 0;
export function newClientId(): string {
  return `c${++seq}-${Math.random().toString(36).slice(2, 8)}`;
}

export function toDrafts(blocks: Block[]): BlockDraft[] {
  return blocks.map((b) => ({
    clientId: b.id,
    id: b.id,
    targetId: b.targetId,
    startUtc: b.startUtc,
    endUtc: b.endUtc,
    note: b.note,
  }));
}

function canonical(d: BlockDraft) {
  return { id: d.id ?? null, targetId: d.targetId, startUtc: d.startUtc, endUtc: d.endUtc, note: d.note };
}

/** True when the drafts differ from the confirmed server blocks. */
export function isDirty(drafts: BlockDraft[], confirmed: Block[]): boolean {
  const conf = confirmed.map((b) => ({
    id: b.id,
    targetId: b.targetId,
    startUtc: b.startUtc,
    endUtc: b.endUtc,
    note: b.note,
  }));
  const dr = drafts.map(canonical);
  if (dr.length !== conf.length) return true;
  const key = (x: any) => `${x.id}|${x.targetId}|${x.startUtc}|${x.endUtc}|${x.note}`;
  const a = conf.map(key).sort();
  const b = dr.map(key).sort();
  return a.some((v, i) => v !== b[i]);
}

/** clientIds of drafts that overlap another draft (single instrument). */
export function findOverlaps(drafts: BlockDraft[]): Set<string> {
  const bad = new Set<string>();
  const sorted = [...drafts].sort((a, b) => a.startUtc - b.startUtc);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startUtc >= sorted[i].endUtc) break;
      bad.add(sorted[i].clientId);
      bad.add(sorted[j].clientId);
    }
  }
  return bad;
}

/**
 * Immediate client-side visibility feedback: a block is OK only if it fits
 * inside one of the target's observable windows from the latest compute.
 * The server re-checks this authoritatively on save.
 */
export function visibilityProblems(
  drafts: BlockDraft[],
  night: NightResult | null,
): Map<string, string> {
  const problems = new Map<string, string>();
  if (!night) return problems;
  const byTarget = new Map(night.targets.map((t) => [t.id, t.windows]));
  for (const d of drafts) {
    if (!(d.startUtc < d.endUtc)) {
      problems.set(d.clientId, '开始必须早于结束');
      continue;
    }
    const windows = byTarget.get(d.targetId);
    if (!windows) {
      problems.set(d.clientId, '该目标不在当前计算结果中');
      continue;
    }
    const ok = windows.some((w) => d.startUtc >= w.start && d.endUtc <= w.end);
    if (!ok) {
      problems.set(d.clientId, '超出可观测窗口（高度不足或天未黑）');
    }
  }
  return problems;
}

/** Linear-interpolated altitude (deg) at time t from computed samples. */
export function altitudeAt(samples: { t: number; alt: number }[], t: number): number | null {
  if (samples.length === 0 || t < samples[0].t || t > samples[samples.length - 1].t) return null;
  for (let i = 1; i < samples.length; i++) {
    if (t <= samples[i].t) {
      const a = samples[i - 1];
      const b = samples[i];
      const f = (t - a.t) / (b.t - a.t);
      return a.alt + f * (b.alt - a.alt);
    }
  }
  return samples[samples.length - 1].alt;
}

/** True when a compute response's echoed params match the current selection. */
export function matchesSelection(
  night: NightResult,
  sel: { lat: number; lon: number; elevation: number; date: string; timezone: string },
): boolean {
  const r = night.request;
  return (
    r.lat === sel.lat &&
    r.lon === sel.lon &&
    r.elevation === sel.elevation &&
    r.date === sel.date &&
    r.timezone === sel.timezone
  );
}
