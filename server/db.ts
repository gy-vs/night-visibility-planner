/**
 * SQLite 持久化层（sql.js / WebAssembly 版 SQLite，本地文件持久化）。
 *
 * - 块时间一律以 UTC 毫秒整数存储（绝对时刻），与时区/本地日期无关，
 *   因此换时区显示或夜间跨本地午夜都不会发生偏移。
 * - 保存整个计划在单个 SQL 事务（BEGIN…COMMIT）内完成：
 *   要么全部写入并整体落盘，要么 ROLLBACK 完全不写，
 *   不会出现部分块更新的混合状态。
 * - plans.version 为乐观锁：保存时必须与 expectedVersion 匹配。
 * - 写操作由一把进程内互斥锁串行化，保证“读版本 → 校验 → 提交”原子，
 *   并发保存请求不会互相越过乐观锁检查。
 */
import initSqlJs, { type Database } from 'sql.js';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Block, Plan, PlanSummary, Site, Target } from '../shared/types.js';

const require = createRequire(import.meta.url);

interface PlanRow {
  id: string;
  site_id: string;
  local_date: string;
  timezone: string;
  sun_max_alt: number;
  version: number;
  targets_json: string;
  updated_at: string;
}

export class VersionConflictError extends Error {
  constructor(
    public serverVersion: number,
    public planId: string,
  ) {
    super(`计划已被其他会话更新：服务器版本 ${serverVersion}`);
    this.name = 'VersionConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

type Row = Record<string, unknown>;

export class Store {
  private db: Database;
  private writeChain: Promise<unknown> = Promise.resolve();
  private memory: boolean;

  private constructor(db: Database, private filename: string) {
    this.db = db;
    this.memory = filename === ':memory:';
    db.run('PRAGMA foreign_keys = ON');
    this.migrate();
    this.seed();
  }

  static async create(filename: string): Promise<Store> {
    const SQL = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
    });
    let db: Database;
    if (filename !== ':memory:' && existsSync(filename)) {
      db = new SQL.Database(readFileSync(filename));
    } else {
      db = new SQL.Database();
    }
    return new Store(db, filename);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sites (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        elevation_meters REAL NOT NULL DEFAULT 0,
        default_timezone TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        timezone TEXT NOT NULL,
        sun_max_alt REAL NOT NULL DEFAULT -18,
        version INTEGER NOT NULL DEFAULT 1,
        targets_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        UNIQUE(site_id, local_date, timezone)
      );

      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        color TEXT,
        pos INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_blocks_plan ON blocks(plan_id);

      CREATE TABLE IF NOT EXISTS plan_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL,
        from_version INTEGER NOT NULL,
        to_version INTEGER NOT NULL,
        at_utc TEXT NOT NULL
      );
    `);
  }

  private seed(): void {
    const n = this.getOne('SELECT COUNT(*) AS n FROM sites');
    if (Number(n?.n) > 0) return;
    const now = new Date().toISOString();
    const seeds: Site[] = [
      {
        id: 'site-lulin',
        name: '鹿林天文台（台湾南投）',
        latitude: 23.4683,
        longitude: 120.8727,
        elevationMeters: 2862,
        defaultTimezone: 'Asia/Taipei',
      },
      {
        id: 'site-xinglong',
        name: '兴隆观测站（河北承德）',
        latitude: 40.3958,
        longitude: 117.5772,
        elevationMeters: 960,
        defaultTimezone: 'Asia/Shanghai',
      },
      {
        id: 'site-purple-mountain',
        name: '紫金山天文台（南京）',
        latitude: 32.0667,
        longitude: 118.8333,
        elevationMeters: 267,
        defaultTimezone: 'Asia/Shanghai',
      },
      {
        id: 'site-mauna-kea',
        name: 'Mauna Kea（夏威夷）',
        latitude: 19.8207,
        longitude: -155.4681,
        elevationMeters: 4205,
        defaultTimezone: 'Pacific/Honolulu',
      },
      {
        id: 'site-la-silla',
        name: 'La Silla（智利）',
        latitude: -29.2567,
        longitude: -70.7383,
        elevationMeters: 2400,
        defaultTimezone: 'America/Santiago',
      },
    ];
    this.db.run('BEGIN');
    try {
      for (const s of seeds) {
        this.db.run(
          `INSERT INTO sites (id, name, latitude, longitude, elevation_meters, default_timezone, created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [
            s.id,
            s.name,
            s.latitude,
            s.longitude,
            s.elevationMeters,
            s.defaultTimezone,
            now,
          ],
        );
      }
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  // ---------- 查询辅助 ----------
  private getOne(sql: string, params: unknown[] = []): Row | null {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as SqlValue[]);
    try {
      if (stmt.step()) return stmt.getAsObject() as Row;
      return null;
    } finally {
      stmt.free();
    }
  }

  private getAll(sql: string, params: unknown[] = []): Row[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as SqlValue[]);
    const rows: Row[] = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject() as Row);
    } finally {
      stmt.free();
    }
    return rows;
  }

  private exec(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as SqlValue[]);
  }

  /** 把整个内存数据库原子写入磁盘（临时文件 + rename） */
  private flush(): void {
    if (this.memory) return;
    mkdirSync(dirname(this.filename), { recursive: true });
    const data = this.db.export();
    const tmp = `${this.filename}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, Buffer.from(data));
    renameSync(tmp, this.filename);
  }

  // ---------- 站点 ----------
  listSites(): Site[] {
    return this.getAll('SELECT * FROM sites ORDER BY name').map(rowToSite);
  }

  getSite(id: string): Site | null {
    const row = this.getOne('SELECT * FROM sites WHERE id = ?', [id]);
    return row ? rowToSite(row) : null;
  }

  async createSite(site: Omit<Site, 'id'>): Promise<Site> {
    const full: Site = { ...site, id: `site-${randomUUID()}` };
    const run = () => {
      this.exec(
        `INSERT INTO sites (id, name, latitude, longitude, elevation_meters, default_timezone, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          full.id,
          full.name,
          full.latitude,
          full.longitude,
          full.elevationMeters,
          full.defaultTimezone,
          new Date().toISOString(),
        ],
      );
      this.flush();
      return full;
    };
    const result = this.writeChain.then(run);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ---------- 计划 ----------
  findPlan(siteId: string, localDate: string, timezone: string): Plan | null {
    const row = this.getOne(
      'SELECT * FROM plans WHERE site_id = ? AND local_date = ? AND timezone = ?',
      [siteId, localDate, timezone],
    ) as PlanRow | null;
    return row ? this.hydrate(row) : null;
  }

  getPlan(id: string): Plan | null {
    const row = this.getOne('SELECT * FROM plans WHERE id = ?', [id]) as
      | PlanRow
      | null;
    return row ? this.hydrate(row) : null;
  }

  listPlans(): PlanSummary[] {
    return this.getAll(
      `SELECT id, site_id, local_date, timezone, sun_max_alt, version, updated_at
       FROM plans ORDER BY updated_at DESC`,
    ).map((r) => ({
      id: String(r.id),
      siteId: String(r.site_id),
      localDate: String(r.local_date),
      timezone: String(r.timezone),
      sunMaxAltitudeDeg: Number(r.sun_max_alt),
      version: Number(r.version),
      updatedAtUtc: String(r.updated_at),
    }));
  }

  private hydrate(row: PlanRow): Plan {
    const blockRows = this.getAll('SELECT * FROM blocks WHERE plan_id = ? ORDER BY pos', [
      row.id,
    ]);
    return {
      id: row.id,
      siteId: row.site_id,
      localDate: row.local_date,
      timezone: row.timezone,
      sunMaxAltitudeDeg: row.sun_max_alt,
      version: row.version,
      updatedAtUtc: row.updated_at,
      site: this.getSite(row.site_id),
      targets: JSON.parse(row.targets_json) as Target[],
      blocks: blockRows.map(blockFromRow),
    };
  }

  /**
   * 原子保存（乐观锁）。
   * expectedVersion=0：新建；>0：必须等于当前版本，否则抛 VersionConflictError。
   * 所有检查与写入在一个事务内，且与其他写操作串行；提交成功后整体落盘。
   */
  savePlan(input: {
    expectedVersion: number;
    siteId: string;
    localDate: string;
    timezone: string;
    sunMaxAltitudeDeg: number;
    targets: Target[];
    blocks: Block[];
  }): Promise<Plan> {
    const run = (): Plan => {
      this.db.run('BEGIN IMMEDIATE');
      try {
        const row = this.getOne(
          'SELECT * FROM plans WHERE site_id = ? AND local_date = ? AND timezone = ?',
          [input.siteId, input.localDate, input.timezone],
        ) as PlanRow | null;

        let planId: string;
        let nextVersion: number;

        if (input.expectedVersion === 0) {
          if (row) throw new VersionConflictError(row.version, row.id);
          planId = `plan-${randomUUID()}`;
          nextVersion = 1;
          this.exec(
            `INSERT INTO plans (id, site_id, local_date, timezone, sun_max_alt, version, targets_json, updated_at)
             VALUES (?,?,?,?,?,1,?,?)`,
            [
              planId,
              input.siteId,
              input.localDate,
              input.timezone,
              input.sunMaxAltitudeDeg,
              JSON.stringify(input.targets),
              new Date().toISOString(),
            ],
          );
        } else {
          if (!row) {
            throw new NotFoundError(
              `计划不存在，无法更新到版本 ${input.expectedVersion}`,
            );
          }
          if (row.version !== input.expectedVersion) {
            throw new VersionConflictError(row.version, row.id);
          }
          planId = row.id;
          nextVersion = row.version + 1;
          this.exec(
            `UPDATE plans SET sun_max_alt = ?, targets_json = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
            [
              input.sunMaxAltitudeDeg,
              JSON.stringify(input.targets),
              nextVersion,
              new Date().toISOString(),
              planId,
              row.version,
            ],
          );
          this.exec('DELETE FROM blocks WHERE plan_id = ?', [planId]);
        }

        this.writeBlocks(planId, input.blocks);
        this.exec(
          'INSERT INTO plan_events (plan_id, from_version, to_version, at_utc) VALUES (?,?,?,?)',
          [
            planId,
            input.expectedVersion,
            nextVersion,
            new Date().toISOString(),
          ],
        );

        this.db.run('COMMIT');
        const saved = this.getPlan(planId);
        if (!saved) throw new Error('保存后无法读回计划');
        this.flush();
        return saved;
      } catch (err) {
        this.db.run('ROLLBACK');
        throw err;
      }
    };

    // 串行化所有写事务
    const result = this.writeChain.then(run);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private writeBlocks(planId: string, blocks: Block[]): void {
    blocks.forEach((b, i) => {
      const s = Date.parse(b.start);
      const e = Date.parse(b.end);
      if (Number.isNaN(s) || Number.isNaN(e) || e <= s) {
        throw new Error(`块 ${b.id} 时间非法（服务端拒绝写入）`);
      }
      this.exec(
        `INSERT INTO blocks (id, plan_id, target_id, start_ms, end_ms, color, pos)
         VALUES (?,?,?,?,?,?,?)`,
        [b.id, planId, b.targetId, s, e, b.color ?? null, i],
      );
    });
  }
}

type SqlValue = string | number | null | Uint8Array;

interface SiteRowS {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  elevation_meters: number;
  default_timezone: string;
}

function rowToSite(r: Row): Site {
  const s = r as unknown as SiteRowS;
  return {
    id: s.id,
    name: s.name,
    latitude: s.latitude,
    longitude: s.longitude,
    elevationMeters: s.elevation_meters,
    defaultTimezone: s.default_timezone,
  };
}

function blockFromRow(r: Row): Block {
  const block: Block = {
    id: String(r.id),
    targetId: String(r.target_id),
    start: new Date(Number(r.start_ms)).toISOString(),
    end: new Date(Number(r.end_ms)).toISOString(),
  };
  if (r.color != null) block.color = String(r.color);
  return block;
}

let storePromise: Promise<Store> | null = null;

export function getStore(
  path = process.env.NWB_DB ?? 'data/nwb.sqlite',
): Promise<Store> {
  if (!storePromise) storePromise = Store.create(path);
  return storePromise;
}
