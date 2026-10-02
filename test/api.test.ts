import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/index';
import { Store } from '../server/db';
import type {
  ComputeResult,
  Plan,
  SavePlanResponse,
  Target,
} from '../shared/types';

let server: Server;
let base: string;
let store: Store;
let siteId: string;

const orion: Target = {
  id: 'alnitak',
  name: 'Alnitak',
  raHours: 5 + 40 / 60 + 45.5 / 3600,
  decDeg: -(1 + 56 / 60 + 34 / 3600),
  minAltitudeDeg: 30,
};

beforeAll(async () => {
  store = await Store.create(':memory:');
  await new Promise<void>((resolve) => {
    server = createApp(store).listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  // 显式使用北半球中纬度的兴隆站（块时间按北京夜间编排）
  siteId = store.listSites().find((s) => s.id === 'site-xinglong')!.id;
});

afterAll(
  () =>
    new Promise<void>((done) => {
      server.close(() => {
        store.close();
        done();
      });
    }),
);

async function api<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<{ status: number; body: T }> {
  const headers = new Headers(init?.headers);
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(base + path, { ...init, headers, body });
  const json = (await res.json()) as T;
  return { status: res.status, body: json };
}

describe('计算入口', () => {
  it('回显地点/日期/目标条件并返回暗空窗口与可见窗口', async () => {
    const { status, body } = await api<ComputeResult>('/api/compute', {
      method: 'POST',
      json: {
        requestId: 'r1',
        siteId,
        localDate: '2026-10-01',
        timezone: 'Asia/Shanghai',
        targets: [orion],
      },
    });
    expect(status).toBe(200);
    expect(body.requestId).toBe('r1');
    expect(body.echo.siteId).toBe(siteId);
    expect(body.echo.localDate).toBe('2026-10-01');
    expect(body.targets.alnitak.observableIntervals.length).toBeGreaterThan(0);
  });

  it('未知站点返回 400', async () => {
    const { status } = await api('/api/compute', {
      method: 'POST',
      json: {
        siteId: 'nope',
        localDate: '2026-10-01',
        timezone: 'Asia/Shanghai',
        targets: [],
      },
    });
    expect(status).toBe(400);
  });
});

describe('保存入口：服务端复核 + 乐观锁', () => {
  const night = () => ({
    siteId,
    localDate: '2026-10-02',
    timezone: 'Asia/Shanghai',
    sunMaxAltitudeDeg: -18,
    targets: [orion],
  });

  /** 取该目标在指定夜内第一个可观测窗口 */
  async function firstWindow(localDate = '2026-10-02'): Promise<{
    start: string;
    end: string;
  }> {
    const { body } = await api<ComputeResult>('/api/compute', {
      method: 'POST',
      json: { ...night(), localDate },
    });
    const w = body.targets.alnitak.observableIntervals[0];
    expect(w).toBeTruthy();
    return w;
  }

  it('合法块保存成功并返回版本 1；刷新可重新读回', async () => {
    const w = await firstWindow();
    const start = new Date(Date.parse(w.start) + 60_000).toISOString();
    const end = new Date(Date.parse(start) + 30 * 60_000).toISOString();
    const { status, body } = await api<SavePlanResponse>('/api/plans/save', {
      method: 'POST',
      json: {
        ...night(),
        expectedVersion: 0,
        blocks: [{ id: 'blk-1', targetId: 'alnitak', start, end }],
      },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.plan.version).toBe(1);

    const reread = await api<{ plan: Plan }>(
      `/api/plans/by-night?siteId=${siteId}&localDate=2026-10-02&timezone=Asia/Shanghai`,
    );
    expect(reread.body.plan.blocks[0].id).toBe('blk-1');
  });

  it('白天/低于最低高度的块被服务端拒绝（422），不写入', async () => {
    const { status, body } = await api<SavePlanResponse>('/api/plans/save', {
      method: 'POST',
      json: {
        ...night(),
        expectedVersion: 0,
        blocks: [
          {
            id: 'day-block',
            targetId: 'alnitak',
            start: '2026-10-02T05:00:00.000Z', // 北京下午，太阳在地平线上
            end: '2026-10-02T05:30:00.000Z',
          },
        ],
      },
    });
    expect(status).toBe(422);
    if (body.ok !== false) throw new Error('expected failure');
    expect(body.status).toBe(422);
    const got = await api<{ plan: Plan | null }>(
      `/api/plans/by-night?siteId=${siteId}&localDate=2026-10-02&timezone=Asia/Shanghai`,
    );
    // 上一用例保存的是 2026-10-02？为避免耦合，这里只确认该非法块不存在
    if (got.body.plan) {
      expect(
        got.body.plan.blocks.some((b) => b.id === 'day-block'),
      ).toBe(false);
    }
  });

  it('两个窗口并发编辑同一夜：后提交者收到 409 与服务器最新安排', async () => {
    const date = '2026-10-03';
    const key = { ...night(), localDate: date };
    const w = await firstWindow(date);
    const mk = (id: string, minute: number) => {
      const start = new Date(Date.parse(w.start) + minute * 60_000).toISOString();
      const end = new Date(Date.parse(start) + 20 * 60_000).toISOString();
      return { id, targetId: 'alnitak', start, end };
    };

    const a = await api<SavePlanResponse>('/api/plans/save', {
      method: 'POST',
      json: { ...key, expectedVersion: 0, blocks: [mk('a', 5)] },
    });
    expect(a.status).toBe(200);
    const b = await api<SavePlanResponse>('/api/plans/save', {
      method: 'POST',
      json: { ...key, expectedVersion: 0, blocks: [mk('b', 40)] },
    });
    // 第二个窗口以为自己是新建 → 409
    expect(b.status).toBe(409);
    if (b.body.ok !== false || b.body.status !== 409) {
      throw new Error('expected version_conflict');
    }
    expect(b.body.serverPlan.version).toBe(1);
    expect(b.body.serverPlan.blocks[0].id).toBe('a');
  });

  it('同目标重叠块被 422 拒绝', async () => {
    const w = await firstWindow('2026-10-04');
    const start = new Date(Date.parse(w.start) + 60_000).toISOString();
    const end = new Date(Date.parse(start) + 40 * 60_000).toISOString();
    const { status } = await api<SavePlanResponse>('/api/plans/save', {
      method: 'POST',
      json: {
        ...night(),
        localDate: '2026-10-04',
        expectedVersion: 0,
        blocks: [
          { id: 'x1', targetId: 'alnitak', start, end },
          { id: 'x2', targetId: 'alnitak', start, end },
        ],
      },
    });
    expect(status).toBe(422);
  });
});
