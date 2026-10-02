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

export interface PlanState {
  plan: Plan;
  blocks: Block[];
}

export interface Window {
  start: number;
  end: number;
}

export interface TargetResult {
  id: string;
  ra: number;
  dec: number;
  minAlt: number;
  samples: { t: number; alt: number }[];
  windows: Window[];
  maxAltitude: number;
}

export interface NightResult {
  request: {
    lat: number;
    lon: number;
    elevation: number;
    date: string;
    timezone: string;
    sunLimit: number;
    targets: { id: string; ra: number; dec: number; minAlt: number }[];
  };
  computedAt: string;
  scan: Window;
  sun: {
    limit: number;
    samples: { t: number; alt: number }[];
    darkWindows: Window[];
    minAltitude: number;
  };
  targets: TargetResult[];
}

export interface Violation {
  blockId: string | null;
  targetId: string | null;
  code: string;
  message: string;
}
