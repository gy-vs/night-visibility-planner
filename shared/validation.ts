import type {
  Block,
  BlockViolation,
  Target,
  UtcInterval,
} from './types.js';

/** 半开区间 [start, end) 是否重叠（按毫秒比较） */
export function intervalsOverlap(a: UtcInterval, b: UtcInterval): boolean {
  const as = Date.parse(a.start);
  const ae = Date.parse(a.end);
  const bs = Date.parse(b.start);
  const be = Date.parse(b.end);
  return as < be && bs < ae;
}

/** block 是否完全落在给定的某个窗口内（窗口端点做了 toleranceMs 放宽） */
export function blockInSomeInterval(
  block: UtcInterval,
  windows: UtcInterval[],
  toleranceMs = 0,
): boolean {
  const s = Date.parse(block.start);
  const e = Date.parse(block.end);
  return windows.some(
    (w) =>
      s >= Date.parse(w.start) - toleranceMs &&
      e <= Date.parse(w.end) + toleranceMs,
  );
}

/** 同一目标的块两两重叠检测（不同目标可同时拍摄，不报冲突） */
export function findOverlappingBlocks(blocks: Block[]): Set<string> {
  const bad = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (
        blocks[i].targetId === blocks[j].targetId &&
        intervalsOverlap(blocks[i], blocks[j])
      ) {
        bad.add(blocks[i].id);
        bad.add(blocks[j].id);
      }
    }
  }
  return bad;
}

export interface ValidateOptions {
  /** targetId -> 可观测窗口 */
  windowsByTarget: Map<string, UtcInterval[]>;
  /** 边界容差（服务端按计算精度放宽） */
  toleranceMs?: number;
}

/**
 * 纯逻辑校验：块必须有合法时长、目标存在，且完全落在该目标的某个可观测窗口内；
 * 同一目标的块不得互相重叠。前端实时反馈与服务端保存前复核共用同一套规则。
 */
export function validateBlocks(
  blocks: Block[],
  targets: Target[],
  opts: ValidateOptions,
): BlockViolation[] {
  const violations: BlockViolation[] = [];
  const targetIds = new Set(targets.map((t) => t.id));
  const overlaps = findOverlappingBlocks(blocks);

  for (const block of blocks) {
    const start = Date.parse(block.start);
    const end = Date.parse(block.end);
    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      end <= start
    ) {
      violations.push({
        blockId: block.id,
        code: 'block_invalid',
        message: '拍摄块起止时间非法或时长为零',
      });
      continue;
    }
    if (!targetIds.has(block.targetId)) {
      violations.push({
        blockId: block.id,
        code: 'target_missing',
        message: `块 ${block.id} 引用的目标不存在`,
      });
      continue;
    }
    const windows = opts.windowsByTarget.get(block.targetId) ?? [];
    if (!blockInSomeInterval(block, windows, opts.toleranceMs ?? 0)) {
      violations.push({
        blockId: block.id,
        code: 'outside_window',
        message: '拍摄块超出该目标的可观测窗口（最低高度 + 太阳暗空条件）',
      });
    }
    if (overlaps.has(block.id)) {
      violations.push({
        blockId: block.id,
        code: 'block_overlap',
        message: '同一目标的拍摄块时间重叠',
      });
    }
  }
  return violations;
}

/** 每个块一条状态，供时间轴/检查器即时标记 */
export type BlockStatus = 'ok' | 'window' | 'overlap' | 'invalid';

export function statusForBlocks(
  blocks: Block[],
  targets: Target[],
  windowsByTarget: Map<string, UtcInterval[]>,
  toleranceMs = 0,
): Map<string, BlockStatus> {
  const violations = validateBlocks(blocks, targets, {
    windowsByTarget,
    toleranceMs,
  });
  const status = new Map<string, BlockStatus>(
    blocks.map((b) => [b.id, 'ok']),
  );
  const rank: Record<BlockStatus, number> = {
    ok: 0,
    overlap: 1,
    window: 2,
    invalid: 3,
  };
  const codeMap: Record<string, BlockStatus> = {
    target_missing: 'invalid',
    outside_window: 'window',
    block_overlap: 'overlap',
    block_invalid: 'invalid',
  };
  for (const v of violations) {
    const next = codeMap[v.code] ?? 'invalid';
    const cur = status.get(v.blockId) ?? 'ok';
    if (rank[next] > rank[cur]) status.set(v.blockId, next);
  }
  return status;
}
