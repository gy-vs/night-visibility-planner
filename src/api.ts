import type {
  Block,
  ComputeRequest,
  ComputeResult,
  Plan,
  PlanSummary,
  SavePlanRequest,
  SavePlanResponse,
  Site,
} from '../shared/types';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const data = (text ? JSON.parse(text) : null) as T;
  if (!res.ok && res.status >= 500) {
    throw new Error(`服务器错误 ${res.status}`);
  }
  return data;
}

export const api = {
  listSites: () => jsonFetch<{ sites: Site[] }>('/api/sites'),

  createSite: (site: Omit<Site, 'id'>) =>
    jsonFetch<{ site: Site }>('/api/sites', {
      method: 'POST',
      body: JSON.stringify(site),
    }),

  /**
   * 计算可见性。signal 用于在条件变化时主动取消旧请求；
   * requestId 由调用方生成，响应原样带回，用于丢弃晚到的结果。
   */
  compute: (req: ComputeRequest, signal?: AbortSignal) =>
    jsonFetch<ComputeResult>('/api/compute', {
      method: 'POST',
      body: JSON.stringify(req),
      signal,
    }),

  planByNight: (siteId: string, localDate: string, timezone: string) =>
    jsonFetch<{ plan: Plan | null }>(
      `/api/plans/by-night?siteId=${encodeURIComponent(siteId)}` +
        `&localDate=${encodeURIComponent(localDate)}` +
        `&timezone=${encodeURIComponent(timezone)}`,
    ),

  listPlans: () => jsonFetch<{ plans: PlanSummary[] }>('/api/plans'),

  savePlan: (req: SavePlanRequest) =>
    jsonFetch<SavePlanResponse>('/api/plans/save', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
};

export function newBlockId(): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `blk-${Date.now().toString(36)}-${rnd}`;
}

export type { Block };
