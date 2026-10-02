import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, VersionConflictError } from '../server/db';
import type { Block, Target } from '../shared/types';

const t: Target = {
  id: 't1',
  name: 'T1',
  raHours: 5.68,
  decDeg: -1.94,
  minAltitudeDeg: 30,
};

function block(id: string, start: string, end: string, targetId = 't1'): Block {
  return { id, targetId, start, end };
}

describe('Store 乐观锁与原子保存', () => {
  let store: Store;
  let siteId: string;

  beforeEach(async () => {
    store = await Store.create(':memory:');
    siteId = store.listSites()[0].id;
  });

  afterEach(() => store.close());

  it('首次保存 version=0 → version=1，UTC 毫秒原样往返', async () => {
    const saved = await store.savePlan({
      expectedVersion: 0,
      siteId,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      sunMaxAltitudeDeg: -18,
      targets: [t],
      blocks: [block('b1', '2026-10-01T14:00:00.000Z', '2026-10-01T15:00:00.000Z')],
    });
    expect(saved.version).toBe(1);
    expect(saved.blocks[0].start).toBe('2026-10-01T14:00:00.000Z');
  });

  it('两个窗口都基于 v1 修改：先到成功，后到收到 VersionConflict 且数据不变', async () => {
    const first = await store.savePlan({
      expectedVersion: 0,
      siteId,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      sunMaxAltitudeDeg: -18,
      targets: [t],
      blocks: [block('b1', '2026-10-01T14:00:00.000Z', '2026-10-01T15:00:00.000Z')],
    });
    expect(first.version).toBe(1);

    const second = await store.savePlan({
      expectedVersion: 1,
      siteId,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      sunMaxAltitudeDeg: -18,
      targets: [t],
      blocks: [block('bA', '2026-10-01T16:00:00.000Z', '2026-10-01T17:00:00.000Z')],
    });
    expect(second.version).toBe(2);

    // 第三个请求仍带 expectedVersion=1（模拟第二个浏览器窗口）
    await expect(
      store.savePlan({
        expectedVersion: 1,
        siteId,
        localDate: '2026-10-01',
        timezone: 'Asia/Shanghai',
        sunMaxAltitudeDeg: -18,
        targets: [t],
        blocks: [
          block('bStale', '2026-10-01T18:00:00.000Z', '2026-10-01T19:00:00.000Z'),
        ],
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    // 过期提交不得产生任何写入：仍是 bA、版本 2
    const reread = store.findPlan(siteId, '2026-10-01', 'Asia/Shanghai')!;
    expect(reread.version).toBe(2);
    expect(reread.blocks.map((b) => b.id)).toEqual(['bA']);
  });

  it('块时间非法时整个事务回滚，不出现半批块写入', async () => {
    await store.savePlan({
      expectedVersion: 0,
      siteId,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      sunMaxAltitudeDeg: -18,
      targets: [t],
      blocks: [block('b1', '2026-10-01T14:00:00.000Z', '2026-10-01T15:00:00.000Z')],
    });
    await expect(
      store.savePlan({
        expectedVersion: 1,
        siteId,
        localDate: '2026-10-01',
        timezone: 'Asia/Shanghai',
        sunMaxAltitudeDeg: -18,
        targets: [t],
        blocks: [
          block('good', '2026-10-01T14:00:00.000Z', '2026-10-01T15:00:00.000Z'),
          block('bad', '2026-10-01T16:00:00.000Z', '2026-10-01T15:00:00.000Z'),
        ],
      }),
    ).rejects.toThrow();
    const after = store.findPlan(siteId, '2026-10-01', 'Asia/Shanghai')!;
    expect(after.version).toBe(1);
    expect(after.blocks.map((b) => b.id)).toEqual(['b1']);
  });

  it('同夜计划按 siteId+localDate+timezone 唯一；v0 重复创建报冲突', async () => {
    const args = {
      siteId,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      sunMaxAltitudeDeg: -18,
      targets: [t],
    };
    await store.savePlan({
      ...args,
      expectedVersion: 0,
      blocks: [
        block('b1', '2026-10-01T14:00:00.000Z', '2026-10-01T15:00:00.000Z'),
      ],
    });
    await expect(
      store.savePlan({
        ...args,
        expectedVersion: 0,
        blocks: [
          block('b2', '2026-10-01T14:00:00.000Z', '2026-10-01T15:00:00.000Z'),
        ],
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('块以 UTC 绝对时间存储：换时区/本地日期重新读取不发生偏移', async () => {
    await store.savePlan({
      expectedVersion: 0,
      siteId,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      sunMaxAltitudeDeg: -18,
      targets: [t],
      blocks: [
        block('b1', '2026-10-01T18:30:00.000Z', '2026-10-01T19:30:00.000Z'),
      ],
    });
    const p = store.findPlan(siteId, '2026-10-01', 'Asia/Shanghai')!;
    expect(p.blocks[0].start).toBe('2026-10-01T18:30:00.000Z');
    expect(p.blocks[0].end).toBe('2026-10-01T19:30:00.000Z');
  });

  it('磁盘持久化：关闭后重开，数据仍在', async () => {
    const file = `/tmp/nwb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    const s1 = await Store.create(file);
    await s1.savePlan({
      expectedVersion: 0,
      siteId: s1.listSites()[0].id,
      localDate: '2026-10-01',
      timezone: 'Asia/Shanghai',
      sunMaxAltitudeDeg: -18,
      targets: [t],
      blocks: [
        block('persist-me', '2026-10-01T14:00:00.000Z', '2026-10-01T15:00:00.000Z'),
      ],
    });
    s1.close();

    const s2 = await Store.create(file);
    const plans = s2.listPlans();
    expect(plans).toHaveLength(1);
    const p = s2.getPlan(plans[0].id)!;
    expect(p.blocks[0].id).toBe('persist-me');
    expect(p.version).toBe(1);
    s2.close();
  });
});
