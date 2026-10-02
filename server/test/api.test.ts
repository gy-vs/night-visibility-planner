import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb, type DB } from '../src/db.js';
import { computeNight } from '../src/astro.js';
import type { Express } from 'express';

let db: DB;
let app: Express;
let siteId: string;
let targetId: string;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp(db);
  const site = await request(app)
    .post('/api/sites')
    .send({ name: 'Test', lat: 19.8207, lon: -155.4681, elevation: 4205, timezone: 'Pacific/Honolulu' });
  siteId = site.body.site.id;
  const target = await request(app)
    .post('/api/targets')
    .send({ name: 'M42', ra: 5.5881, dec: -5.3911, minAlt: 25 });
  targetId = target.body.target.id;
});

const DATE = '2026-03-15';

async function ensurePlan() {
  const res = await request(app).post('/api/plans/ensure').send({ siteId, date: DATE });
  expect(res.status).toBe(200);
  return res.body as { plan: { id: string; version: number }; blocks: any[] };
}

/** A block that is definitely inside M42's observable window that night. */
function goodBlock(): { targetId: string; startUtc: number; endUtc: number; note: string } {
  const night = computeNight({
    lat: 19.8207, lon: -155.4681, elevation: 4205,
    date: DATE, timezone: 'Pacific/Honolulu',
    targets: [{ id: targetId, ra: 5.5881, dec: -5.3911, minAlt: 25 }],
  });
  const w = night.targets[0].windows[0];
  expect(w).toBeDefined();
  const start = w.start + 10 * 60_000;
  return { targetId, startUtc: start, endUtc: start + 45 * 60_000, note: 'ok' };
}

describe('plan save flow', () => {
  it('saves a valid block and bumps the version', async () => {
    const { plan } = await ensurePlan();
    const res = await request(app)
      .put(`/api/plans/${plan.id}/blocks`)
      .send({ baseVersion: plan.version, blocks: [goodBlock()] });
    expect(res.status).toBe(200);
    expect(res.body.plan.version).toBe(plan.version + 1);
    expect(res.body.blocks).toHaveLength(1);
  });

  it('persists blocks across reads (refresh survival)', async () => {
    const { plan } = await ensurePlan();
    const b = goodBlock();
    await request(app).put(`/api/plans/${plan.id}/blocks`).send({ baseVersion: plan.version, blocks: [b] });
    const again = await request(app).post('/api/plans/ensure').send({ siteId, date: DATE });
    expect(again.body.blocks).toHaveLength(1);
    expect(again.body.blocks[0].startUtc).toBe(b.startUtc);
  });

  it('rejects a block when the target is below minAlt (server re-checks)', async () => {
    const { plan } = await ensurePlan();
    const night = computeNight({
      lat: 19.8207, lon: -155.4681, elevation: 4205,
      date: DATE, timezone: 'Pacific/Honolulu',
      targets: [{ id: targetId, ra: 5.5881, dec: -5.3911, minAlt: 25 }],
    });
    // Pick a dark time when M42 is down: middle of the night scan but outside windows.
    const t = night.scan.start + 2 * 3600_000; // early afternoon local — sun up
    const res = await request(app)
      .put(`/api/plans/${plan.id}/blocks`)
      .send({ baseVersion: plan.version, blocks: [{ targetId, startUtc: t, endUtc: t + 3600_000, note: '' }] });
    expect(res.status).toBe(422);
    expect(res.body.violations.length).toBeGreaterThan(0);
    // Nothing was written.
    const after = await request(app).get(`/api/plans/${plan.id}`);
    expect(after.body.blocks).toHaveLength(0);
    expect(after.body.plan.version).toBe(plan.version);
  });

  it('rejects overlapping blocks and writes nothing (atomic)', async () => {
    const { plan } = await ensurePlan();
    const a = goodBlock();
    const b = { ...goodBlock(), startUtc: a.startUtc + 15 * 60_000, endUtc: a.endUtc + 15 * 60_000 };
    const res = await request(app)
      .put(`/api/plans/${plan.id}/blocks`)
      .send({ baseVersion: plan.version, blocks: [a, b] });
    expect(res.status).toBe(422);
    expect(res.body.violations.some((v: any) => v.code === 'overlap')).toBe(true);
    const after = await request(app).get(`/api/plans/${plan.id}`);
    expect(after.body.blocks).toHaveLength(0);
    expect(after.body.plan.version).toBe(plan.version);
  });

  it('rejects a stale baseVersion with 409 and the current server state', async () => {
    const { plan } = await ensurePlan();
    const first = await request(app)
      .put(`/api/plans/${plan.id}/blocks`)
      .send({ baseVersion: plan.version, blocks: [goodBlock()] });
    expect(first.status).toBe(200);

    // Second writer still holding the old version.
    const stale = await request(app)
      .put(`/api/plans/${plan.id}/blocks`)
      .send({ baseVersion: plan.version, blocks: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.current.plan.version).toBe(plan.version + 1);
    expect(stale.body.current.blocks).toHaveLength(1);

    // The first writer's block survived; no silent overwrite happened.
    const after = await request(app).get(`/api/plans/${plan.id}`);
    expect(after.body.blocks).toHaveLength(1);
  });

  it('lets the stale writer recover by re-saving against the fresh version', async () => {
    const { plan } = await ensurePlan();
    await request(app).put(`/api/plans/${plan.id}/blocks`).send({ baseVersion: plan.version, blocks: [goodBlock()] });
    const stale = await request(app)
      .put(`/api/plans/${plan.id}/blocks`)
      .send({ baseVersion: plan.version, blocks: [] });
    const freshVersion = stale.body.current.plan.version;
    const retry = await request(app)
      .put(`/api/plans/${plan.id}/blocks`)
      .send({ baseVersion: freshVersion, blocks: [] });
    expect(retry.status).toBe(200);
    expect(retry.body.blocks).toHaveLength(0);
  });

  it('does not shift stored times across a date boundary', async () => {
    const { plan } = await ensurePlan();
    const b = goodBlock(); // M42 window crosses local midnight in March at Mauna Kea
    await request(app).put(`/api/plans/${plan.id}/blocks`).send({ baseVersion: plan.version, blocks: [b] });
    const after = await request(app).get(`/api/plans/${plan.id}`);
    // Stored as exact UTC instants — identical to what was sent.
    expect(after.body.blocks[0].startUtc).toBe(b.startUtc);
    expect(after.body.blocks[0].endUtc).toBe(b.endUtc);
  });
});
