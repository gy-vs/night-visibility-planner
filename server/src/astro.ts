import * as Astronomy from 'astronomy-engine';

export interface TargetInput {
  id: string;
  /** Right ascension in hours */
  ra: number;
  /** Declination in degrees */
  dec: number;
  /** Minimum acceptable altitude in degrees */
  minAlt: number;
}

export interface NightRequest {
  lat: number;
  lon: number;
  elevation: number;
  /** Local observing date, YYYY-MM-DD, interpreted in `timezone` */
  date: string;
  /** IANA timezone, e.g. "America/Los_Angeles" */
  timezone: string;
  /** Sun altitude (deg) defining darkness. Default -18 (astronomical). */
  sunLimit?: number;
  targets: TargetInput[];
}

export interface Window {
  start: number; // epoch ms (UTC)
  end: number;
}

export interface TargetResult {
  id: string;
  ra: number;
  dec: number;
  minAlt: number;
  samples: { t: number; alt: number }[];
  /** Intervals where the target is above minAlt AND the sun is below sunLimit */
  windows: Window[];
  maxAltitude: number;
}

export interface NightResult {
  /** Echo of the exact parameters the computation was based on. */
  request: Required<Omit<NightRequest, 'targets'>> & { targets: TargetInput[] };
  computedAt: string;
  /** Scan range: local noon -> next local noon, epoch ms UTC. */
  scan: Window;
  sun: {
    limit: number;
    samples: { t: number; alt: number }[];
    darkWindows: Window[];
    minAltitude: number;
  };
  targets: TargetResult[];
}

const STEP_MS = 5 * 60_000;
const SAMPLE_MS = 10 * 60_000;

/** Offset (ms) of `tz` wall clock ahead of UTC at instant `utcMs`. */
function tzOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - utcMs;
}

/** Convert a wall-clock time in `tz` to an epoch-ms UTC instant. */
export function zonedLocalToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - tzOffsetMs(tz, guess);
  // One refinement pass handles being near an offset transition.
  utc = guess - tzOffsetMs(tz, utc);
  return utc;
}

/** Root-refined scan for intervals where `f` crosses `threshold`. */
export function findWindows(
  f: (t: number) => number,
  t0: number,
  t1: number,
  threshold: number,
  mode: 'above' | 'below',
  stepMs = STEP_MS,
): Window[] {
  const g = (t: number) => (mode === 'above' ? f(t) - threshold : threshold - f(t));
  const windows: Window[] = [];
  let openStart: number | null = g(t0) > 0 ? t0 : null;
  let prevT = t0;
  let prevV = g(t0);
  for (let t = t0 + stepMs; ; t += stepMs) {
    const ct = Math.min(t, t1);
    const v = g(ct);
    if ((prevV > 0 && v <= 0) || (prevV <= 0 && v > 0)) {
      // Bisect the crossing between prevT and ct to ~1s precision.
      let lo = prevT;
      let hi = ct;
      let loV = prevV;
      for (let i = 0; i < 40 && hi - lo > 1000; i++) {
        const mid = (lo + hi) / 2;
        const mv = g(mid);
        if (mv > 0 === loV > 0) {
          lo = mid;
          loV = mv;
        } else {
          hi = mid;
        }
      }
      const cross = (lo + hi) / 2;
      if (prevV > 0) {
        // leaving the satisfied region
        if (openStart !== null) windows.push({ start: openStart, end: cross });
        openStart = null;
      } else {
        openStart = cross;
      }
    }
    prevT = ct;
    prevV = v;
    if (ct >= t1) break;
  }
  if (openStart !== null) windows.push({ start: openStart, end: t1 });
  return windows
    .filter((w) => w.end - w.start > 1000)
    .map((w) => ({ start: Math.round(w.start), end: Math.round(w.end) }));
}

export function intersectWindows(a: Window[], b: Window[]): Window[] {
  const out: Window[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end - start > 1000) out.push({ start, end });
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

function sample(f: (t: number) => number, t0: number, t1: number, stepMs: number) {
  const out: { t: number; alt: number }[] = [];
  for (let t = t0; t <= t1; t += stepMs) out.push({ t, alt: f(t) });
  if (out[out.length - 1].t < t1) out.push({ t: t1, alt: f(t1) });
  return out;
}

export function computeNight(req: NightRequest): NightResult {
  const observer = new Astronomy.Observer(req.lat, req.lon, req.elevation);
  const [Y, M, D] = req.date.split('-').map(Number);
  const t0 = zonedLocalToUtc(Y, M, D, 12, 0, req.timezone);
  const t1 = t0 + 24 * 3600_000;
  const sunLimit = req.sunLimit ?? -18;

  const sunAlt = (t: number) => {
    const d = new Date(t);
    const eq = Astronomy.Equator(Astronomy.Body.Sun, d, observer, true, true);
    return Astronomy.Horizon(d, observer, eq.ra, eq.dec, 'normal').altitude;
  };

  const sunSamples = sample(sunAlt, t0, t1, SAMPLE_MS);
  const darkWindows = findWindows(sunAlt, t0, t1, sunLimit, 'below');
  const minAltitude = Math.min(...sunSamples.map((s) => s.alt));

  const targets: TargetResult[] = req.targets.map((tg) => {
    const alt = (t: number) =>
      Astronomy.Horizon(new Date(t), observer, tg.ra, tg.dec, 'normal').altitude;
    const above = findWindows(alt, t0, t1, tg.minAlt, 'above');
    const windows = intersectWindows(above, darkWindows);
    const samples = sample(alt, t0, t1, SAMPLE_MS);
    return {
      id: tg.id,
      ra: tg.ra,
      dec: tg.dec,
      minAlt: tg.minAlt,
      samples,
      windows,
      maxAltitude: Math.max(...samples.map((s) => s.alt)),
    };
  });

  return {
    request: {
      lat: req.lat,
      lon: req.lon,
      elevation: req.elevation,
      date: req.date,
      timezone: req.timezone,
      sunLimit,
      targets: req.targets,
    },
    computedAt: new Date().toISOString(),
    scan: { start: t0, end: t1 },
    sun: { limit: sunLimit, samples: sunSamples, darkWindows, minAltitude },
    targets,
  };
}

/**
 * Minimum altitude (deg) of a fixed target over [startUtc, endUtc].
 * Samples densely enough (1 min) that a smooth altitude curve cannot dip
 * below the sampled minimum by more than a small tolerance.
 */
export function minAltitudeOver(
  observer: Astronomy.Observer,
  ra: number,
  dec: number,
  startUtc: number,
  endUtc: number,
): number {
  let min = Infinity;
  const step = 60_000;
  for (let t = startUtc; t <= endUtc; t += step) {
    const alt = Astronomy.Horizon(new Date(t), observer, ra, dec, 'normal').altitude;
    if (alt < min) min = alt;
  }
  const altEnd = Astronomy.Horizon(new Date(endUtc), observer, ra, dec, 'normal').altitude;
  return Math.min(min, altEnd);
}
