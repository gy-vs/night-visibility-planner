import { describe, expect, it } from 'vitest';
import {
  altitudeAt,
  findOverlaps,
  isDirty,
  matchesSelection,
  toDrafts,
  visibilityProblems,
  type BlockDraft,
} from './plan';
import type { Block, NightResult } from './types';

const T0 = 1_800_000_000_000;
const H = 3600_000;

function draft(p: Partial<BlockDraft>): BlockDraft {
  return { clientId: 'x', targetId: 't1', startUtc: T0, endUtc: T0 + H, note: '', ...p };
}

function block(p: Partial<Block>): Block {
  return { id: 'b1', planId: 'p', targetId: 't1', startUtc: T0, endUtc: T0 + H, note: '', ...p };
}

const night: NightResult = {
  request: { lat: 19.8, lon: -155.5, elevation: 4205, date: '2026-03-15', timezone: 'Pacific/Honolulu', sunLimit: -18, targets: [] },
  computedAt: '',
  scan: { start: T0, end: T0 + 24 * H },
  sun: { limit: -18, samples: [], darkWindows: [{ start: T0 + 6 * H, end: T0 + 18 * H }], minAltitude: -70 },
  targets: [
    {
      id: 't1', ra: 5.5, dec: -5.4, minAlt: 25,
      samples: [
        { t: T0, alt: -10 },
        { t: T0 + 12 * H, alt: 60 },
        { t: T0 + 24 * H, alt: -10 },
      ],
      windows: [{ start: T0 + 8 * H, end: T0 + 16 * H }],
      maxAltitude: 60,
    },
  ],
};

describe('isDirty', () => {
  it('is false right after loading confirmed blocks', () => {
    expect(isDirty(toDrafts([block({})]), [block({})])).toBe(false);
  });
  it('detects moved, added and removed blocks', () => {
    const confirmed = [block({})];
    expect(isDirty(toDrafts(confirmed).map((d) => ({ ...d, startUtc: d.startUtc + 1 })), confirmed)).toBe(true);
    expect(isDirty([...toDrafts(confirmed), draft({ clientId: 'n', id: undefined })], confirmed)).toBe(true);
    expect(isDirty([], confirmed)).toBe(true);
  });
});

describe('findOverlaps', () => {
  it('flags both blocks of an overlapping pair', () => {
    const a = draft({ clientId: 'a', startUtc: T0, endUtc: T0 + 2 * H });
    const b = draft({ clientId: 'b', startUtc: T0 + H, endUtc: T0 + 3 * H });
    const c = draft({ clientId: 'c', startUtc: T0 + 4 * H, endUtc: T0 + 5 * H });
    const bad = findOverlaps([a, b, c]);
    expect([...bad].sort()).toEqual(['a', 'b']);
  });
  it('treats touching blocks as non-overlapping', () => {
    const a = draft({ clientId: 'a', startUtc: T0, endUtc: T0 + H });
    const b = draft({ clientId: 'b', startUtc: T0 + H, endUtc: T0 + 2 * H });
    expect(findOverlaps([a, b]).size).toBe(0);
  });
});

describe('visibilityProblems', () => {
  it('accepts a block fully inside an observable window', () => {
    const d = draft({ startUtc: T0 + 9 * H, endUtc: T0 + 10 * H });
    expect(visibilityProblems([d], night).size).toBe(0);
  });
  it('rejects blocks outside the window even while it is dark', () => {
    // Dark from +6h to +18h, but target only observable +8h..+16h.
    const d = draft({ startUtc: T0 + 6.5 * H, endUtc: T0 + 7.5 * H });
    expect(visibilityProblems([d], night).size).toBe(1);
  });
});

describe('altitudeAt', () => {
  it('interpolates between samples', () => {
    expect(altitudeAt(night.targets[0].samples, T0 + 6 * H)).toBeCloseTo(25);
  });
  it('returns null outside the sampled range', () => {
    expect(altitudeAt(night.targets[0].samples, T0 - 1)).toBeNull();
  });
});

describe('matchesSelection', () => {
  it('guards against applying a late response to a new selection', () => {
    const sel = { lat: 19.8, lon: -155.5, elevation: 4205, date: '2026-03-15', timezone: 'Pacific/Honolulu' };
    expect(matchesSelection(night, sel)).toBe(true);
    expect(matchesSelection(night, { ...sel, date: '2026-03-16' })).toBe(false);
    expect(matchesSelection(night, { ...sel, lat: -24.6 })).toBe(false);
  });
});
