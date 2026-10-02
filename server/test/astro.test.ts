import { describe, expect, it } from 'vitest';
import { computeNight, zonedLocalToUtc, type NightRequest } from '../src/astro.js';

const base: Omit<NightRequest, 'date' | 'lat' | 'lon' | 'timezone'> = {
  elevation: 0,
  targets: [{ id: 't1', ra: 5.5881, dec: -5.3911, minAlt: 25 }], // M42
};

describe('zonedLocalToUtc', () => {
  it('converts wall clock to UTC respecting the zone offset', () => {
    // Honolulu is UTC-10 year round.
    expect(zonedLocalToUtc(2026, 3, 15, 12, 0, 'Pacific/Honolulu')).toBe(
      Date.UTC(2026, 2, 15, 22, 0),
    );
  });
  it('handles DST transitions without drifting', () => {
    // America/Santiago: summer time (UTC-3) in January, winter (UTC-4) in July.
    const summer = zonedLocalToUtc(2026, 1, 15, 12, 0, 'America/Santiago');
    const winter = zonedLocalToUtc(2026, 7, 15, 12, 0, 'America/Santiago');
    expect(summer - Date.UTC(2026, 0, 15, 12, 0)).toBe(3 * 3600_000);
    expect(winter - Date.UTC(2026, 6, 15, 12, 0)).toBe(4 * 3600_000);
  });
});

describe('computeNight', () => {
  it('echoes the request parameters it computed from', () => {
    const res = computeNight({ ...base, lat: 19.82, lon: -155.47, date: '2026-03-15', timezone: 'Pacific/Honolulu' });
    expect(res.request.lat).toBeCloseTo(19.82);
    expect(res.request.date).toBe('2026-03-15');
    expect(res.request.timezone).toBe('Pacific/Honolulu');
    expect(res.request.targets[0]).toMatchObject({ id: 't1', ra: 5.5881, minAlt: 25 });
  });

  it('produces different windows for the same target at different sites', () => {
    const a = computeNight({ ...base, lat: 19.82, lon: -155.47, date: '2026-03-15', timezone: 'Pacific/Honolulu' });
    const b = computeNight({ ...base, lat: -24.63, lon: -70.4, date: '2026-03-15', timezone: 'America/Santiago' });
    expect(a.targets[0].windows.length).toBeGreaterThan(0);
    expect(b.targets[0].windows.length).toBeGreaterThan(0);
    expect(a.targets[0].windows[0].start).not.toBe(b.targets[0].windows[0].start);
    expect(a.targets[0].maxAltitude).not.toBeCloseTo(b.targets[0].maxAltitude, 1);
  });

  it('produces different windows on different dates at the same site', () => {
    const a = computeNight({ ...base, lat: 19.82, lon: -155.47, date: '2026-03-15', timezone: 'Pacific/Honolulu' });
    const b = computeNight({ ...base, lat: 19.82, lon: -155.47, date: '2026-06-15', timezone: 'Pacific/Honolulu' });
    expect(a.targets[0].windows[0]?.start).not.toBe(b.targets[0].windows[0]?.start);
  });

  it('night boundaries come from the sun, not a fixed offset', () => {
    // High-latitude site: night length varies dramatically with season.
    const site = { lat: 51.5, lon: -0.12, timezone: 'Europe/London', elevation: 0, targets: [] };
    const winter = computeNight({ ...site, date: '2026-01-15' });
    const summer = computeNight({ ...site, date: '2026-06-15' });
    const len = (r: typeof winter) =>
      r.sun.darkWindows.reduce((s, w) => s + (w.end - w.start), 0) / 3600_000;
    expect(len(winter)).toBeGreaterThan(10);
    expect(len(summer)).toBeLessThan(5);
  });

  it('keeps observable windows inside darkness and above minAlt', () => {
    const res = computeNight({ ...base, lat: 19.82, lon: -155.47, date: '2026-03-15', timezone: 'Pacific/Honolulu' });
    for (const w of res.targets[0].windows) {
      const insideDark = res.sun.darkWindows.some((d) => w.start >= d.start - 1 && w.end <= d.end + 1);
      expect(insideDark).toBe(true);
      const mid = res.targets[0].samples.find((s) => Math.abs(s.t - (w.start + w.end) / 2) < 10 * 60_000);
      expect(mid!.alt).toBeGreaterThan(25);
    }
  });

  it('returns no windows for a target that never rises high enough', () => {
    const res = computeNight({
      elevation: 0,
      lat: 28.76,
      lon: -17.88,
      date: '2026-03-15',
      timezone: 'Atlantic/Canary',
      targets: [{ id: 'south', ra: 13.446, dec: -47.48, minAlt: 60 }],
    });
    expect(res.targets[0].windows).toHaveLength(0);
    expect(res.targets[0].maxAltitude).toBeLessThan(60);
  });
});
