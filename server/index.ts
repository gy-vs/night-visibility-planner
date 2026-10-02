import express from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type {
  Block,
  ComputeRequest,
  ComputeResult,
  ConflictDetail,
  Plan,
  SavePlanRequest,
  SavePlanResponse,
  Site,
  Target,
} from '../shared/types.js';
import { computeNight } from './astronomy.js';
import {
  NotFoundError,
  Store,
  VersionConflictError,
} from './db.js';
import { validateBlocks } from '../shared/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.NWB_PORT ? Number(process.env.NWB_PORT) : 4317;

export function createApp(store: Store): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ---------- 站点 ----------
  app.get('/api/sites', (_req, res) => {
    res.json({ sites: store.listSites() });
  });

  app.post('/api/sites', async (req, res) => {
    const b = req.body ?? {};
    if (
      typeof b.name !== 'string' ||
      !b.name.trim() ||
      !Number.isFinite(b.latitude) ||
      !Number.isFinite(b.longitude) ||
      Math.abs(b.latitude) > 90 ||
      Math.abs(b.longitude) > 180 ||
      typeof b.defaultTimezone !== 'string'
    ) {
      res.status(400).json({
        ok: false,
        error: 'bad_request',
        message: '站点参数不合法（名称、纬度 -90..90、经度 -180..180、时区必填）',
      });
      return;
    }
    const created = await store.createSite({
      name: b.name.trim(),
      latitude: b.latitude,
      longitude: b.longitude,
      elevationMeters: Number.isFinite(b.elevationMeters)
        ? b.elevationMeters
        : 0,
      defaultTimezone: b.defaultTimezone,
    });
    res.status(201).json({ site: created });
  });

  // ---------- 天文计算（只读权威结果） ----------
  app.post('/api/compute', (req, res) => {
    try {
      const result = doCompute(req.body as ComputeRequest, store);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: 'bad_compute_request',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------- 计划读取 ----------
  app.get('/api/plans', (_req, res) => {
    res.json({ plans: store.listPlans() });
  });

  app.get('/api/plans/by-night', (req, res) => {
    const { siteId, localDate, timezone } = req.query;
    if (
      typeof siteId !== 'string' ||
      typeof localDate !== 'string' ||
      typeof timezone !== 'string'
    ) {
      res
        .status(400)
        .json({ ok: false, error: 'bad_request', message: '缺少查询参数' });
      return;
    }
    const plan = store.findPlan(siteId, localDate, timezone);
    res.json({ plan });
  });

  app.get('/api/plans/:id', (req, res) => {
    const plan = store.getPlan(req.params.id);
    if (!plan) {
      res
        .status(404)
        .json({ ok: false, error: 'not_found', message: '计划不存在' });
      return;
    }
    res.json({ plan });
  });

  // ---------- 计划保存（乐观锁 + 服务端重新校验） ----------
  app.post('/api/plans/save', async (req, res) => {
    const body = req.body as Partial<SavePlanRequest>;
    if (
      !body ||
      typeof body.siteId !== 'string' ||
      typeof body.localDate !== 'string' ||
      typeof body.timezone !== 'string' ||
      !Array.isArray(body.targets) ||
      !Array.isArray(body.blocks) ||
      typeof body.expectedVersion !== 'number' ||
      !Number.isFinite(body.sunMaxAltitudeDeg)
    ) {
      res.status(400).json({
        ok: false,
        status: 400,
        error: 'bad_request',
        message: '保存请求缺少必填字段',
      } satisfies SavePlanResponse);
      return;
    }

    const site = store.getSite(body.siteId);
    if (!site) {
      res.status(404).json({
        ok: false,
        status: 404,
        error: 'site_not_found',
        message: `站点 ${body.siteId} 不存在`,
      } satisfies SavePlanResponse);
      return;
    }

    const targets = body.targets as Target[];
    const blocks = body.blocks as Block[];
    for (const b of blocks) {
      if (
        typeof b.id !== 'string' ||
        typeof b.targetId !== 'string' ||
        Number.isNaN(Date.parse(b.start)) ||
        Number.isNaN(Date.parse(b.end)) ||
        Date.parse(b.end) <= Date.parse(b.start)
      ) {
        res.status(422).json({
          ok: false,
          status: 422,
          error: 'constraint_violations',
          message: '存在非法拍摄块',
          conflicts: [
            {
              blockId: String(b.id ?? '?'),
              code: 'block_invalid',
              message: '块缺少 id/targetId 或起止时间非法',
            },
          ],
        } satisfies SavePlanResponse);
        return;
      }
    }

    // 服务端用自己的天文引擎重新计算，不信任浏览器之前画的窗口
    let computed: ComputeResult;
    try {
      computed = doCompute(
        {
          siteId: site.id,
          localDate: body.localDate,
          timezone: body.timezone,
          sunMaxAltitudeDeg: body.sunMaxAltitudeDeg,
          targets,
        },
        store,
      );
    } catch (err) {
      res.status(400).json({
        ok: false,
        status: 400,
        error: 'bad_compute_request',
        message: err instanceof Error ? err.message : String(err),
      } satisfies SavePlanResponse);
      return;
    }

    const windowsByTarget = new Map(
      Object.values(computed.targets).map((t) => [
        t.targetId,
        t.observableIntervals,
      ]),
    );
    // 采样间隔 5 分钟 + 细化 15 秒，给边界留 5 分钟容差，
    // 允许块恰好卡在边界采样格上；超出窗口的安排仍会被拒。
    const violations = validateBlocks(blocks, targets, {
      windowsByTarget,
      toleranceMs: 5 * 60 * 1000,
    });
    if (violations.length > 0) {
      const conflicts: ConflictDetail[] = violations.map((v) => ({
        blockId: v.blockId,
        code: v.code,
        message: v.message,
      }));
      res.status(422).json({
        ok: false,
        status: 422,
        error: 'constraint_violations',
        message:
          '服务端重新计算后发现以下块不满足可见性或冲突约束，未保存任何内容',
        conflicts,
      } satisfies SavePlanResponse);
      return;
    }

    try {
      const plan = await store.savePlan({
        expectedVersion: body.expectedVersion,
        siteId: body.siteId,
        localDate: body.localDate,
        timezone: body.timezone,
        sunMaxAltitudeDeg: body.sunMaxAltitudeDeg,
        targets,
        blocks,
      });
      res.json({ ok: true, plan } satisfies SavePlanResponse);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        const serverPlan = store.getPlan(err.planId);
        if (!serverPlan) throw err;
        res.status(409).json({
          ok: false,
          status: 409,
          error: 'version_conflict',
          message:
            `该夜计划已被另一个会话更新到版本 ${err.serverVersion}，` +
            '你的修改基于过期版本。请重新取得服务器安排后再决定如何合并。',
          serverPlan,
        } satisfies SavePlanResponse);
        return;
      }
      if (err instanceof NotFoundError) {
        res.status(404).json({
          ok: false,
          status: 404,
          error: 'not_found',
          message: err.message,
        } satisfies SavePlanResponse);
        return;
      }
      throw err;
    }
  });

  // ---------- 生产模式托管构建产物 ----------
  const distDir = join(__dirname, '..', 'dist');
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(join(distDir, 'index.html'));
    });
  }

  // 统一错误处理（保存事务整体回滚后也会走到这里）
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      res
        .status(500)
        .json({ ok: false, error: 'server_error', message: '服务器内部错误' });
    },
  );

  return app;
}

/** 把计算请求解析成 observer（已存站点 id 或临时坐标），调用权威计算 */
function doCompute(req: ComputeRequest, store: Store): ComputeResult {
  if (
    !req ||
    typeof req.localDate !== 'string' ||
    typeof req.timezone !== 'string' ||
    !Array.isArray(req.targets)
  ) {
    throw new Error('计算请求缺少 localDate/timezone/targets');
  }
  let latitude: number | undefined;
  let longitude: number | undefined;
  let elevationMeters = 0;
  let siteId: string | null = null;
  let siteName: string | null = null;

  if (req.siteId) {
    const site = store.getSite(req.siteId);
    if (!site) throw new Error(`站点 ${req.siteId} 不存在`);
    latitude = site.latitude;
    longitude = site.longitude;
    elevationMeters = site.elevationMeters;
    siteId = site.id;
    siteName = site.name;
  } else if (req.site) {
    latitude = req.site.latitude;
    longitude = req.site.longitude;
    elevationMeters = req.site.elevationMeters ?? 0;
    siteName = req.site.name ?? '临时坐标';
  } else {
    throw new Error('必须提供 siteId 或 site 坐标');
  }

  const targets: Target[] = req.targets.map((t, i) => ({
    id: typeof t.id === 'string' && t.id ? t.id : `target-${i}`,
    name: typeof t.name === 'string' && t.name ? t.name : `目标 ${i + 1}`,
    raHours: Number(t.raHours),
    decDeg: Number(t.decDeg),
    minAltitudeDeg: Number(t.minAltitudeDeg),
  }));

  return computeNight({
    observer: { latitude, longitude, elevationMeters },
    localDate: req.localDate,
    timezone: req.timezone,
    sunMaxAltitudeDeg:
      req.sunMaxAltitudeDeg === undefined ? -18 : req.sunMaxAltitudeDeg,
    targets,
    requestId: req.requestId ?? randomUUID(),
    siteId,
    siteName,
  });
}

async function main(): Promise<void> {
  const { getStore } = await import('./db.js');
  const store = await getStore();
  const app = createApp(store);
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`观测夜排程工作台 API: http://127.0.0.1:${PORT}`);
    console.log(`前端开发服务器: http://127.0.0.1:5180  (npm run dev)`);
  });
}

// 仅在作为入口直接运行时启动（被测试 import 时不启动）
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
