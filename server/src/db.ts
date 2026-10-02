import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface Site {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elevation: number;
  timezone: string;
}

export interface Target {
  id: string;
  name: string;
  ra: number;
  dec: number;
  minAlt: number;
}

export interface Plan {
  id: string;
  siteId: string;
  date: string;
  version: number;
  updatedAt: string;
}

export interface Block {
  id: string;
  planId: string;
  targetId: string;
  startUtc: number;
  endUtc: number;
  note: string;
}

export type DB = Database.Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      elevation REAL NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS targets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ra REAL NOT NULL,
      dec REAL NOT NULL,
      min_alt REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(id),
      date TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(site_id, date)
    );
    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES targets(id),
      start_utc INTEGER NOT NULL,
      end_utc INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

export function seedIfEmpty(db: DB): void {
  const n = (db.prepare('SELECT COUNT(*) AS c FROM sites').get() as { c: number }).c;
  if (n > 0) return;
  const insertSite = db.prepare(
    'INSERT INTO sites (id, name, lat, lon, elevation, timezone) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertTarget = db.prepare(
    'INSERT INTO targets (id, name, ra, dec, min_alt) VALUES (?, ?, ?, ?, ?)',
  );
  const tx = db.transaction(() => {
    insertSite.run(randomUUID(), 'Mauna Kea, HI', 19.8207, -155.4681, 4205, 'Pacific/Honolulu');
    insertSite.run(randomUUID(), 'Cerro Paranal, Chile', -24.6272, -70.4042, 2635, 'America/Santiago');
    insertSite.run(randomUUID(), 'La Palma, Spain', 28.7624, -17.8792, 2396, 'Atlantic/Canary');
    insertTarget.run(randomUUID(), 'M31 Andromeda', 0.7123, 41.2692, 30);
    insertTarget.run(randomUUID(), 'M42 Orion Nebula', 5.5881, -5.3911, 25);
    insertTarget.run(randomUUID(), 'Omega Centauri', 13.446, -47.4803, 20);
  });
  tx();
}

// ---- row mapping helpers ----

export function siteRows(db: DB): Site[] {
  return db.prepare('SELECT * FROM sites ORDER BY name').all() as unknown as Site[];
}

export function targetRows(db: DB): Target[] {
  const rows = db.prepare('SELECT * FROM targets ORDER BY name').all() as any[];
  return rows.map((r) => ({ id: r.id, name: r.name, ra: r.ra, dec: r.dec, minAlt: r.min_alt }));
}

export function getSite(db: DB, id: string): Site | null {
  return (db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as Site) ?? null;
}

export function getTarget(db: DB, id: string): Target | null {
  const r = db.prepare('SELECT * FROM targets WHERE id = ?').get(id) as any;
  return r ? { id: r.id, name: r.name, ra: r.ra, dec: r.dec, minAlt: r.min_alt } : null;
}

export function planRow(r: any): Plan {
  return { id: r.id, siteId: r.site_id, date: r.date, version: r.version, updatedAt: r.updated_at };
}

export function blockRow(r: any): Block {
  return {
    id: r.id,
    planId: r.plan_id,
    targetId: r.target_id,
    startUtc: r.start_utc,
    endUtc: r.end_utc,
    note: r.note,
  };
}

export function getPlanWithBlocks(
  db: DB,
  planId: string,
): { plan: Plan; blocks: Block[] } | null {
  const p = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as any;
  if (!p) return null;
  const blocks = (
    db.prepare('SELECT * FROM blocks WHERE plan_id = ? ORDER BY start_utc').all(planId) as any[]
  ).map(blockRow);
  return { plan: planRow(p), blocks };
}

export function ensurePlan(db: DB, siteId: string, date: string): Plan {
  const existing = db
    .prepare('SELECT * FROM plans WHERE site_id = ? AND date = ?')
    .get(siteId, date) as any;
  if (existing) return planRow(existing);
  const id = randomUUID();
  db.prepare('INSERT INTO plans (id, site_id, date, version, updated_at) VALUES (?, ?, ?, 0, ?)').run(
    id,
    siteId,
    date,
    new Date().toISOString(),
  );
  return planRow(db.prepare('SELECT * FROM plans WHERE id = ?').get(id));
}
