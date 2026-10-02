import express, { type Express } from 'express';
import { z } from 'zod';
import * as Astronomy from 'astronomy-engine';
import {
  computeNight,
  minAltitudeOver,
  type NightRequest,
  type Window,
} from './astro.js';
import {
  blockRow,
  ensurePlan,
  getPlanWithBlocks,
  getSite,
  getTarget,
  planRow,
  seedIfEmpty,
  siteRows,
  targetRows,
  type Block,
  type DB,
} from './db.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

const siteSchema = z.object({
  name: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  elevation: z.number().min(-500).max(9000).default(0),
  timezone: z.string().min(1).refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'invalid IANA timezone'),
});

const targetSchema = z.object({
  name: z.string().min(1).max(120),
  ra: z.number().min(0).max(24),
  dec: z.number().min(-90).max(90),
  minAlt: z.number().min(0).max(90),
});

const computeSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  elevation: z.number().min(-500).max(9000).default(0),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: siteSchema.shape.timezone,
  sunLimit: z.number().min(-18).max(0).optional(),
  targets: z.array(
    z.object({
      id: z.string().min(1),
      ra: z.number().min(0).max(24),
      dec: z.number().min(-90).max(90),
      minAlt: z.number().min(0).max(90),
    }),
  ),
});

const blockInputSchema = z.object({
  id: z.string().optional(),
  targetId: z.string().min(1),
  startUtc: z.number().int().positive(),
  endUtc: z.number().int().positive(),
  note: z.string().max(500).default(''),
});

const saveSchema = z.object({
  baseVersion: z.number().int().min(0),
  blocks: z.array(blockInputSchema).max(200),
});

export interface Violation {
  blockId: string | null;
  targetId: string | null;
  code: 'bad_range' | 'unknown_target' | 'below_min_alt' | 'outside_night' | 'overlap';
  message: string;
}

/**
 * Server-side authoritative validation of a set of blocks against freshly
 * computed astronomy for the plan's own site/date — never trusting numbers
 * the browser computed earlier.
 */
export function validateBlocks(
  db: DB,
  siteId: string,
  date: string,
  blocks: z.infer<typeof blockInputSchema>[],
): Violation[] {
  const site = getSite(db, siteId);
  if (!site) return [{ blockId: null, targetId: null, code: 'unknown_target', message: 'site not found' }];
  const violations: Violation[] = [];

  const observer = new Astronomy.Observer(site.lat, site.lon, site.elevation);
  const nightReq: NightRequest = {
    lat: site.lat,
    lon: site.lon,
    elevation: site.elevation,
    date,
    timezone: site.timezone,
    targets: [],
  };
  // Recompute the night's observable windows for every referenced target.
  const targetIds = [...new Set(blocks.map((b) => b.targetId))];
  const targets = targetIds
    .map((id) => getTarget(db, id))
    .filter((t): t is NonNullable<typeof t> => t !== null);
  const night = computeNight({ ...nightReq, targets });
  const windowsByTarget = new Map<string, Window[]>(
    night.targets.map((t) => [t.id, t.windows]),
  );

  for (const b of blocks) {
    const label = `block ${b.id ?? '(new)'}`;
    if (!(b.startUtc < b.endUtc)) {
      violations.push({
        blockId: b.id ?? null,
        targetId: b.targetId,
        code: 'bad_range',
        message: `${label}: start must be before end`,
      });
      continue;
    }
    if (b.endUtc - b.startUtc > 24 * 3600_000) {
      violations.push({
        blockId: b.id ?? null,
        targetId: b.targetId,
        code: 'bad_range',
        message: `${label}: longer than 24h`,
      });
      continue;
    }
    const target = getTarget(db, b.targetId);
    if (!target) {
      violations.push({
        blockId: b.id ?? null,
        targetId: b.targetId,
        code: 'unknown_target',
        message: `${label}: unknown target ${b.targetId}`,
      });
      continue;
    }
    // Must fit inside a single observable window (dark + above minAlt).
    const windows = windowsByTarget.get(b.targetId) ?? [];
    const inside = windows.some((w) => b.startUtc >= w.start - 999 && b.endUtc <= w.end + 999);
    if (!inside) {
      const minAlt = minAltitudeOver(observer, target.ra, target.dec, b.startUtc, b.endUtc);
      violations.push({
        blockId: b.id ?? null,
        targetId: b.targetId,
        code: minAlt < target.minAlt ? 'below_min_alt' : 'outside_night',
        message: `${label}: target "${target.name}" is not observable for the whole block ` +
          `(min altitude during block ≈ ${minAlt.toFixed(1)}°, required ≥ ${target.minAlt}°, and the sun must be down)`,
      });
    }
  }

  // Single instrument: no two blocks may overlap, regardless of target.
  const sorted = [...blocks].sort((a, b) => a.startUtc - b.startUtc);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startUtc < sorted[i - 1].endUtc) {
      violations.push({
        blockId: sorted[i].id ?? null,
        targetId: sorted[i].targetId,
        code: 'overlap',
        message: `blocks overlap: ${sorted[i - 1].id ?? '(new)'} and ${sorted[i].id ?? '(new)'}`,
      });
    }
  }
  return violations;
}

export function createApp(db: DB): Express {
  seedIfEmpty(db);
  const app = express();
  app.use(express.json());

  app.get('/api/sites', (_req, res) => res.json({ sites: siteRows(db) }));

  app.post('/api/sites', (req, res) => {
    const parsed = siteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_site', details: parsed.error.issues });
    const id = randomUUID();
    db.prepare(
      'INSERT INTO sites (id, name, lat, lon, elevation, timezone) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, parsed.data.name, parsed.data.lat, parsed.data.lon, parsed.data.elevation, parsed.data.timezone);
    res.status(201).json({ site: getSite(db, id) });
  });

  app.get('/api/targets', (_req, res) => res.json({ targets: targetRows(db) }));

  app.post('/api/targets', (req, res) => {
    const parsed = targetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_target', details: parsed.error.issues });
    const id = randomUUID();
    db.prepare('INSERT INTO targets (id, name, ra, dec, min_alt) VALUES (?, ?, ?, ?, ?)').run(
      id, parsed.data.name, parsed.data.ra, parsed.data.dec, parsed.data.minAlt,
    );
    res.status(201).json({ target: getTarget(db, id) });
  });

  /**
   * Stateless astronomy computation. The response echoes the exact request
   * parameters so callers can verify the conditions the numbers are based on.
   */
  app.post('/api/compute/night', (req, res) => {
    const parsed = computeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    try {
      res.json(computeNight(parsed.data));
    } catch (e) {
      res.status(400).json({ error: 'compute_failed', message: String(e) });
    }
  });

  /** Fetch (creating if needed) the plan for a site + local date. */
  app.post('/api/plans/ensure', (req, res) => {
    const schema = z.object({ siteId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    if (!getSite(db, parsed.data.siteId)) return res.status(404).json({ error: 'site_not_found' });
    const plan = ensurePlan(db, parsed.data.siteId, parsed.data.date);
    const full = getPlanWithBlocks(db, plan.id)!;
    res.json(full);
  });

  app.get('/api/plans/:id', (req, res) => {
    const full = getPlanWithBlocks(db, req.params.id);
    if (!full) return res.status(404).json({ error: 'plan_not_found' });
    res.json(full);
  });

  /**
   * Replace all blocks of a plan atomically, guarded by optimistic
   * concurrency on `baseVersion`. Constraints are re-validated here.
   */
  app.put('/api/plans/:id/blocks', (req, res) => {
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });

    const current = getPlanWithBlocks(db, req.params.id);
    if (!current) return res.status(404).json({ error: 'plan_not_found' });

    if (current.plan.version !== parsed.data.baseVersion) {
      return res.status(409).json({
        error: 'stale_version',
        message: `plan is at version ${current.plan.version}, you based your edit on ${parsed.data.baseVersion}`,
        current,
      });
    }

    const violations = validateBlocks(db, current.plan.siteId, current.plan.date, parsed.data.blocks);
    if (violations.length > 0) {
      return res.status(422).json({ error: 'validation_failed', violations });
    }

    const save = db.transaction(() => {
      // Re-check the version inside the transaction so two concurrent
      // writers cannot both succeed.
      const r = db
        .prepare('UPDATE plans SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
        .run(new Date().toISOString(), current.plan.id, parsed.data.baseVersion);
      if (r.changes === 0) throw Object.assign(new Error('stale'), { code: 'STALE' });
      db.prepare('DELETE FROM blocks WHERE plan_id = ?').run(current.plan.id);
      const insert = db.prepare(
        'INSERT INTO blocks (id, plan_id, target_id, start_utc, end_utc, note) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const b of parsed.data.blocks) {
        insert.run(b.id ?? randomUUID(), current.plan.id, b.targetId, b.startUtc, b.endUtc, b.note);
      }
    });
    try {
      save();
    } catch (e: any) {
      if (e?.code === 'STALE') {
        return res.status(409).json({
          error: 'stale_version',
          current: getPlanWithBlocks(db, current.plan.id),
        });
      }
      throw e;
    }
    res.json(getPlanWithBlocks(db, current.plan.id));
  });

  // Serve the built frontend when available (production mode).
  const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  return app;
}
