import { describe, expect, it } from 'vitest';
import { computeNight, nightDomain } from '../server/astronomy';
import type { Target } from '../shared/types';

// 猎户腰带附近的恒星（Alnitak，J2000 RA 05h40m45.5s, Dec -01°56′34″）
const alnitak: Target = {
  id: 'alnitak',
  name: 'Alnitak',
  raHours: 5 + 40 / 60 + 45.5 / 3600,
  decDeg: -(1 + 56 / 60 + 34 / 3600),
  minAltitudeDeg: 30,
};

// 北京兴隆
const xinglong = {
  latitude: 40.3958,
  longitude: 117.5772,
  elevationMeters: 960,
};

describe('夜间定义域（本地中午→次日中午）', () => {
  it('Asia/Shanghai 2026-10-01 的容器为 04:00Z → 次日 04:00Z', () => {
    const d = nightDomain('2026-10-01', 'Asia/Shanghai');
    expect(d.start.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(d.end.toISOString()).toBe('2026-10-02T04:00:00.000Z');
  });

  it('夏令时跳变日仍按本地墙钟定义容器（春季 23 小时、绝对 UTC 正确）', () => {
    // 纽约 2026-03-08 02:00 时钟跳到 03:00。容器从 3/7 本地中午起，
    // 跨越该跳变到 3/8 中午，墙钟一天对应 23 绝对小时。
    const d = nightDomain('2026-03-07', 'America/New_York');
    expect(d.end.getTime() - d.start.getTime()).toBe(23 * 3600_000);
    // 3/7 中午 EST(UTC-5)=17:00Z；3/8 中午 EDT(UTC-4)=16:00Z
    expect(d.start.toISOString()).toBe('2026-03-07T17:00:00.000Z');
    expect(d.end.toISOString()).toBe('2026-03-08T16:00:00.000Z');
  });

  it('秋季回退（25 小时）之夜也完整覆盖暗空时段', () => {
    // 纽约 2026-11-01 凌晨 02:00 回退到 01:00；中午前后均为 EST(-5)，
    // 容器 17:00Z → 次日 17:00Z，覆盖含重复小时在内的整夜。
    const d = nightDomain('2026-11-01', 'America/New_York');
    expect(d.start.toISOString()).toBe('2026-11-01T17:00:00.000Z');
    expect(d.end.toISOString()).toBe('2026-11-02T17:00:00.000Z');
  });

  it('非法时区抛错而不是静默回退', () => {
    expect(() => nightDomain('2026-10-01', 'Asia/Foo')).toThrow();
  });
});

describe('太阳暗空窗口', () => {
  it('兴隆 10 月初存在单一夜晚暗空窗口，且落在容器内', () => {
    const r = computeNight({
      observer: xinglong,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      targets: [],
    });
    expect(r.sun.darkIntervals.length).toBeGreaterThanOrEqual(1);
    for (const w of r.sun.darkIntervals) {
      expect(Date.parse(w.start) >= Date.parse(r.echo.nightStartUtc)).toBe(true);
      expect(Date.parse(w.end) <= Date.parse(r.echo.nightEndUtc)).toBe(true);
    }
  });

  it('把太阳高度上限放到 +90（任何时候都算暗空）会覆盖整个容器', () => {
    const r = computeNight({
      observer: xinglong,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      targets: [],
      sunMaxAltitudeDeg: 90,
    });
    expect(r.sun.darkIntervals).toHaveLength(1);
    expect(r.sun.darkIntervals[0].start).toBe(r.echo.nightStartUtc);
    expect(r.sun.darkIntervals[0].end).toBe(r.echo.nightEndUtc);
  });

  it('极区白夜：夏至北极圈内太阳始终高于 -18°，无天文暗空窗口', () => {
    const r = computeNight({
      observer: { latitude: 78, longitude: 15, elevationMeters: 500 },
      localDate: '2026-06-21',
      timezone: 'Europe/Oslo',
      targets: [],
      sunMaxAltitudeDeg: -18,
    });
    expect(r.sun.darkIntervals).toHaveLength(0);
  });
});

describe('目标可见窗口', () => {
  const r = computeNight({
    observer: xinglong,
    localDate: '2026-10-01',
    timezone: 'Asia/Shanghai',
    targets: [alnitak],
  });

  it('可观测窗口 = 高度窗口 ∩ 暗空窗口，恒为高度窗口子集', () => {
    const t = r.targets.alnitak;
    expect(t.altitudeIntervals.length).toBeGreaterThanOrEqual(1);
    expect(t.observableIntervals.length).toBeGreaterThanOrEqual(1);
    const inAny = (iso: string, ws: { start: string; end: string }[]) =>
      ws.some(
        (w) =>
          Date.parse(iso) >= Date.parse(w.start) &&
          Date.parse(iso) <= Date.parse(w.end),
      );
    for (const o of t.observableIntervals) {
      expect(inAny(o.start, t.altitudeIntervals)).toBe(true);
      expect(inAny(o.end, t.altitudeIntervals)).toBe(true);
      expect(inAny(o.start, r.sun.darkIntervals)).toBe(true);
      expect(inAny(o.end, r.sun.darkIntervals)).toBe(true);
    }
  });

  it('窗口边界处高度接近阈值（细化有效）', () => {
    const t = r.targets.alnitak;
    const w = t.altitudeIntervals[0];
    // 上升/下降沿的采样点高度应非常接近 30°
    const startSample = t.samples.find(
      (s) => s.t === w.start || Math.abs(Date.parse(s.t) - Date.parse(w.start)) < 4 * 60_000,
    );
    expect(startSample).toBeTruthy();
    expect(Math.abs(startSample!.altitudeDeg - 30)).toBeLessThan(2);
  });

  it('同一目标换地点窗口不同；最低高度越高窗口越短', () => {
    const south = computeNight({
      observer: { latitude: 23.5, longitude: 117, elevationMeters: 100 },
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      targets: [alnitak],
    });
    const len = (ws: { start: string; end: string }[]) =>
      ws.reduce((acc, w) => acc + (Date.parse(w.end) - Date.parse(w.start)), 0);
    expect(
      len(south.targets.alnitak.altitudeIntervals),
    ).not.toBe(len(r.targets.alnitak.altitudeIntervals));

    const high = { ...alnitak, minAltitudeDeg: 60 };
    const r60 = computeNight({
      observer: xinglong,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      targets: [high],
    });
    expect(
      len(r60.targets.alnitak.altitudeIntervals),
    ).toBeLessThan(len(r.targets.alnitak.altitudeIntervals));
  });

  it('回显计算条件，便于前端核对使用的是哪组地点/日期/目标参数', () => {
    expect(r.echo.latitude).toBe(xinglong.latitude);
    expect(r.echo.longitude).toBe(xinglong.longitude);
    expect(r.echo.localDate).toBe('2026-10-01');
    expect(r.echo.timezone).toBe('Asia/Shanghai');
    expect(r.echo.sunMaxAltitudeDeg).toBe(-18);
    expect(r.echo.sampleStepMinutes).toBe(5);
  });

  it('requestId 原样返回（供前端丢弃过期响应）', () => {
    const rr = computeNight({
      observer: xinglong,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      targets: [alnitak],
      requestId: 'req-abc',
    });
    expect(rr.requestId).toBe('req-abc');
  });
});

describe('与独立参考值的数值核对', () => {
  it('太阳正午高度与独立 NOAA 式赤纬公式一致（误差 < 0.3°）', () => {
    const r = computeNight({
      observer: xinglong,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      targets: [],
    });
    // 独立的简化参考：2026-10-01 太阳赤纬（NOAA 公式），
    // 正午高度 = 90 - |纬度 - 赤纬|
    const rad = Math.PI / 180;
    const dayOfYear = Math.round(
      (Date.parse('2026-10-01T00:00:00Z') -
        Date.parse('2026-01-01T00:00:00Z')) /
        86_400_000,
    ) + 1;
    const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1);
    const decl =
      0.006918 -
      0.399912 * Math.cos(gamma) +
      0.070257 * Math.sin(gamma) -
      0.006758 * Math.cos(2 * gamma) +
      0.000907 * Math.sin(2 * gamma);
    const declDeg = decl / rad;
    const expected = 90 - Math.abs(xinglong.latitude - declDeg);
    expect(Math.abs(r.sun.maxAltitudeDeg - expected)).toBeLessThan(0.3);
  });
});
