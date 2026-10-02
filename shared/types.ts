/**
 * 前后端共享的数据模型与 API 契约。
 * 所有时刻在传输/存储时一律使用绝对时间（ISO 8601 UTC，带 Z 后缀），
 * localDate / tz 仅用于标识“哪个观测夜”，不参与块时间的换算存储。
 */

export interface Site {
  id: string;
  name: string;
  latitude: number; // 度，北正南负
  longitude: number; // 度，东正西负
  elevationMeters: number;
  defaultTimezone: string; // IANA，例如 Asia/Shanghai
}

export interface Target {
  id: string;
  name: string;
  raHours: number; // J2000 平赤经，0..24
  decDeg: number; // J2000 赤纬，-90..90
  minAltitudeDeg: number; // 可接受的最低高度（不含太阳条件）
}

/** 时间区间，[start, end)，ISO 8601 UTC */
export interface UtcInterval {
  start: string;
  end: string;
}

export interface Block {
  id: string;
  targetId: string;
  start: string; // ISO 8601 UTC
  end: string; // ISO 8601 UTC
  color?: string;
}

export type ViolationCode =
  | 'target_missing'
  | 'outside_window'
  | 'block_overlap'
  | 'block_invalid';

export interface BlockViolation {
  blockId: string;
  code: ViolationCode;
  message: string;
}

export interface TargetWindowResult {
  targetId: string;
  /** 该目标满足最低高度的区间（全部小时段） */
  altitudeIntervals: UtcInterval[];
  /** 目标满足最低高度 且 太阳低于 sunMaxAltitudeDeg 的可观测区间 */
  observableIntervals: UtcInterval[];
  /** 全天采样曲线，ISO 时间 + 高度（度） */
  samples: { t: string; altitudeDeg: number }[];
  /** 区间内目标最高高度（度） */
  maxAltitudeDeg: number;
}

export interface SunCurve {
  maxAltitudeDeg: number;
  samples: { t: string; altitudeDeg: number }[];
  /** 太阳低于阈值的暗空区间 */
  darkIntervals: UtcInterval[];
}

export interface ComputeEcho {
  siteId: string | null;
  siteName: string | null;
  latitude: number;
  longitude: number;
  elevationMeters: number;
  localDate: string;
  timezone: string;
  sunMaxAltitudeDeg: number;
  /** 本次计算覆盖的绝对时间范围（本地日期中午到次日中午） */
  nightStartUtc: string;
  nightEndUtc: string;
  sampleStepMinutes: number;
}

export interface ComputeResult {
  /** 原样回显请求中的 requestId，前端用于丢弃晚到的旧计算结果 */
  requestId: string;
  echo: ComputeEcho;
  sun: SunCurve;
  targets: Record<string, TargetWindowResult>;
  computedAtUtc: string;
}

export interface ComputeRequest {
  requestId?: string;
  /** 两种选址方式：已保存站点 id，或表单中的临时坐标 */
  siteId?: string;
  site?: {
    name?: string;
    latitude: number;
    longitude: number;
    elevationMeters?: number;
  };
  localDate: string; // YYYY-MM-DD（站点当地日期，观测夜从该日中午起算）
  timezone: string; // IANA
  sunMaxAltitudeDeg?: number; // 太阳高度上限，默认 -18（天文晨光/昏影）
  targets: Target[];
}

export interface PlanSummary {
  id: string;
  siteId: string;
  localDate: string;
  timezone: string;
  sunMaxAltitudeDeg: number;
  version: number;
  updatedAtUtc: string;
}

export interface Plan extends PlanSummary {
  site: Site | null; // 站点被删除时为 null，计划仍保留
  targets: Target[];
  blocks: Block[];
}

export interface SavePlanRequest {
  expectedVersion: number; // 0 表示新建；非 0 必须与当前版本一致
  siteId: string;
  localDate: string;
  timezone: string;
  sunMaxAltitudeDeg: number;
  targets: Target[];
  blocks: Block[];
}

export interface ConflictDetail {
  blockId: string;
  code: ViolationCode;
  message: string;
}

export type SavePlanResponse =
  | { ok: true; plan: Plan }
  | {
      ok: false;
      status: 409;
      error: 'version_conflict';
      message: string;
      serverPlan: Plan;
    }
  | {
      ok: false;
      status: 422;
      error: 'constraint_violations';
      message: string;
      conflicts: ConflictDetail[];
    }
  | { ok: false; status: 400 | 404; error: string; message: string };
