/**
 * 服务端权威天文计算，基于 astronomy-engine（VSOP87/完整岁差章动，非简化模型）。
 *
 * 夜间定义域：本地日期 D 的 12:00（站点时区）到 D+1 的 12:00，
 * 保证任何纬度下完整的一夜都落在同一个 24 小时容器内，不会因跨过
 * 本地午夜而截断。所有输出时间均为绝对 UTC。
 */
import * as Astronomy from 'astronomy-engine';
import { DateTime } from 'luxon';
import type {
  ComputeEcho,
  ComputeResult,
  SunCurve,
  Target,
  TargetWindowResult,
  UtcInterval,
} from '../shared/types.js';

const DEG = Math.PI / 180;
const SAMPLE_STEP_MINUTES = 5;
const SAMPLE_STEP_MS = SAMPLE_STEP_MINUTES * 60 * 1000;
/** 跨越点二分精度（毫秒） */
const REFINE_TOLERANCE_MS = 15_000;
const DEFAULT_SUN_MAX_ALT = -18; // 天文昏影/晨光

export interface ObserverInput {
  latitude: number;
  longitude: number;
  elevationMeters: number;
}

export interface NightDomain {
  start: Date; // UTC，本地日期中午
  end: Date; // UTC，次日中午
}

/** 观测夜容器：当地日期 12:00 → 次日 12:00 */
export function nightDomain(localDate: string, timezone: string): NightDomain {
  const day = DateTime.fromISO(localDate, { zone: timezone });
  if (!day.isValid) {
    throw new Error(`非法日期或时区: ${localDate} / ${timezone}`);
  }
  const noon = day.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  if (!noon.isValid || noon.zoneName !== resolveZone(timezone)) {
    throw new Error(`无法在时区 ${timezone} 中解释日期 ${localDate}`);
  }
  const start = noon.toUTC().toJSDate();
  const end = noon.plus({ days: 1 }).toUTC().toJSDate();
  return { start, end };
}

function resolveZone(tz: string): string | null {
  return DateTime.local().setZone(tz).zoneName;
}

function makeObserver(o: ObserverInput): Astronomy.Observer {
  return new Astronomy.Observer(
    o.latitude,
    o.longitude,
    o.elevationMeters,
  );
}

/**
 * J2000 平赤经赤纬目标在给定 UTC 时刻的地平高度（度，几何高度）。
 * 用 EQJ→HOR 完整旋转矩阵，内含岁差章动、大气折射以外的全部转换。
 */
export function targetAltitude(
  target: Target,
  observer: Astronomy.Observer,
  when: Date,
): number {
  const raDeg = (target.raHours * 15) % 360;
  const sphere: Astronomy.Spherical = {
    lon: raDeg,
    lat: target.decDeg,
    dist: 1, // 用单位方向向量即可；恒星视差为零，距离只引入浮点误差
  };
  const vecJ2000 = Astronomy.VectorFromSphere(sphere, when);
  const rot = Astronomy.Rotation_EQJ_HOR(when, observer);
  const hor = Astronomy.RotateVector(rot, vecJ2000);
  return Math.asin(clamp(hor.z, -1, 1)) / DEG;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** 太阳地平高度（度）。用 topocentric J2000 向量直接转地平，含视差。 */
export function sunAltitude(
  observer: Astronomy.Observer,
  when: Date,
): number {
  // ofdate=false, aberration=true → J2000 赤道坐标（含光行差）
  const eq = Astronomy.Equator(Astronomy.Body.Sun, when, observer, false, true);
  const sphere: Astronomy.Spherical = {
    lon: eq.ra * 15,
    lat: eq.dec,
    dist: eq.dist,
  };
  const vec = Astronomy.VectorFromSphere(sphere, when);
  const rot = Astronomy.Rotation_EQJ_HOR(when, observer);
  const hor = Astronomy.RotateVector(rot, vec);
  return Math.asin(clamp(hor.z, -1, 1)) / DEG;
}

interface SampledSeries {
  samples: Date[];
  values: number[];
}

function sampleSeries(
  domain: NightDomain,
  f: (t: Date) => number,
): SampledSeries {
  const samples: Date[] = [];
  const values: number[] = [];
  for (let t = domain.start.getTime(); t <= domain.end.getTime(); t += SAMPLE_STEP_MS) {
    const d = new Date(t);
    samples.push(d);
    values.push(f(d));
  }
  return { samples, values };
}

/**
 * 找出 series >= threshold（或 <= threshold）的连续区间，
 * 边界用原始高度函数二分细化到 REFINE_TOLERANCE_MS。返回 [start,end) UTC 毫秒区间。
 */
function thresholdIntervals(
  series: SampledSeries,
  threshold: number,
  mode: 'above' | 'below',
  rawF: (t: Date) => number,
): Array<[number, number]> {
  const { samples, values } = series;
  const ok = (v: number) => (mode === 'above' ? v >= threshold : v <= threshold);
  const out: Array<[number, number]> = [];
  let inside = false;
  let segStart = 0;

  const crossing = (t1: number, v1: number, t2: number, v2: number): number => {
    void v2;
    // 在 (t1,t2) 之间状态翻转，用真实高度函数二分细化
    let lo = t1;
    let hi = t2;
    let loInside = ok(v1);
    for (let i = 0; i < 30; i++) {
      if (hi - lo <= REFINE_TOLERANCE_MS) break;
      const mid = Math.floor((lo + hi) / 2);
      const midInside = ok(rawF(new Date(mid)));
      if (midInside === loInside) {
        lo = mid;
        loInside = midInside;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  };

  for (let i = 0; i < samples.length; i++) {
    const cur = ok(values[i]);
    if (cur && !inside) {
      inside = true;
      segStart =
        i > 0
          ? crossing(samples[i - 1].getTime(), values[i - 1], samples[i].getTime(), values[i])
          : samples[i].getTime();
    } else if (!cur && inside) {
      inside = false;
      const segEnd = crossing(
        samples[i - 1].getTime(),
        values[i - 1],
        samples[i].getTime(),
        values[i],
      );
      out.push([segStart, segEnd]);
    }
  }
  if (inside) out.push([segStart, samples[samples.length - 1].getTime()]);
  return out;
}

function toIntervals(ms: Array<[number, number]>): UtcInterval[] {
  return ms.map(([s, e]) => ({
    start: new Date(s).toISOString(),
    end: new Date(e).toISOString(),
  }));
}

function intersectIntervals(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [as_, ae] of a) {
    for (const [bs, be] of b) {
      const s = Math.max(as_, bs);
      const e = Math.min(ae, be);
      if (s < e) out.push([s, e]);
    }
  }
  return out;
}

export interface ComputeParams {
  observer: ObserverInput;
  localDate: string;
  timezone: string;
  targets: Target[];
  sunMaxAltitudeDeg?: number;
  requestId?: string;
  siteId?: string | null;
  siteName?: string | null;
}

export function computeNight(params: ComputeParams): ComputeResult {
  const {
    observer,
    localDate,
    timezone,
    targets,
    sunMaxAltitudeDeg = DEFAULT_SUN_MAX_ALT,
    requestId = '',
    siteId = null,
    siteName = null,
  } = params;

  if (!Number.isFinite(observer.latitude) || Math.abs(observer.latitude) > 90) {
    throw new Error('纬度必须在 -90..90 之间');
  }
  if (!Number.isFinite(observer.longitude) || Math.abs(observer.longitude) > 180) {
    throw new Error('经度必须在 -180..180 之间');
  }
  for (const t of targets) {
    if (!(t.raHours >= 0 && t.raHours <= 24)) {
      throw new Error(`目标 ${t.name} 赤经须在 0..24 小时之间`);
    }
    if (!(t.decDeg >= -90 && t.decDeg <= 90)) {
      throw new Error(`目标 ${t.name} 赤纬须在 -90..90 度之间`);
    }
    if (!(t.minAltitudeDeg >= 0 && t.minAltitudeDeg < 90)) {
      throw new Error(`目标 ${t.name} 最低高度须在 0..90 度之间`);
    }
  }

  const domain = nightDomain(localDate, timezone);
  const obs = makeObserver(observer);

  const sunSeries = sampleSeries(domain, (t) => sunAltitude(obs, t));
  const darkMs = thresholdIntervals(
    sunSeries,
    sunMaxAltitudeDeg,
    'below',
    (t) => sunAltitude(obs, t),
  );
  const sun: SunCurve = {
    maxAltitudeDeg: Math.max(...sunSeries.values),
    samples: sunSeries.samples.map((t, i) => ({
      t: t.toISOString(),
      altitudeDeg: round3(sunSeries.values[i]),
    })),
    darkIntervals: toIntervals(darkMs),
  };

  const targetResults: Record<string, TargetWindowResult> = {};
  for (const target of targets) {
    const series = sampleSeries(domain, (t) => targetAltitude(target, obs, t));
    const altMs = thresholdIntervals(
      series,
      target.minAltitudeDeg,
      'above',
      (t) => targetAltitude(target, obs, t),
    );
    const obsMs = intersectIntervals(altMs, darkMs);
    targetResults[target.id] = {
      targetId: target.id,
      altitudeIntervals: toIntervals(altMs),
      observableIntervals: toIntervals(obsMs),
      samples: series.samples.map((t, i) => ({
        t: t.toISOString(),
        altitudeDeg: round3(series.values[i]),
      })),
      maxAltitudeDeg: round3(Math.max(...series.values)),
    };
  }

  const echo: ComputeEcho = {
    siteId,
    siteName,
    latitude: observer.latitude,
    longitude: observer.longitude,
    elevationMeters: observer.elevationMeters,
    localDate,
    timezone,
    sunMaxAltitudeDeg,
    nightStartUtc: domain.start.toISOString(),
    nightEndUtc: domain.end.toISOString(),
    sampleStepMinutes: SAMPLE_STEP_MINUTES,
  };

  return {
    requestId,
    echo,
    sun,
    targets: targetResults,
    computedAtUtc: new Date().toISOString(),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
