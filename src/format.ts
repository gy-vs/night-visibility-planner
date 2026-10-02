import { DateTime } from 'luxon';

/** 所有界面显示均把绝对 UTC 转成所选站点时区的本地墙钟时间 */
export function localLabel(iso: string, timezone: string): string {
  return DateTime.fromISO(iso).setZone(timezone).toFormat('HH:mm');
}

export function localLabelFull(iso: string, timezone: string): string {
  return DateTime.fromISO(iso).setZone(timezone).toFormat('MM-dd HH:mm');
}

export function utcLabel(iso: string): string {
  return DateTime.fromISO(iso).toUTC().toFormat('HH:mm') + ' UTC';
}

export function durationLabel(startIso: string, endIso: string): string {
  const mins = Math.round(
    (Date.parse(endIso) - Date.parse(startIso)) / 60000,
  );
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 小时刻度（本地时区墙钟），每小时一条；labelEvery 控制文字密度 */
export function hourTicks(
  startIso: string,
  endIso: string,
  timezone: string,
): { ms: number; label: string | null; major: boolean }[] {
  const start = DateTime.fromISO(startIso).setZone(timezone);
  const end = DateTime.fromISO(endIso).setZone(timezone);
  const ticks: { ms: number; label: string | null; major: boolean }[] = [];
  let t = start;
  let i = 0;
  while (t.toMillis() <= end.toMillis()) {
    const major = t.hour % 2 === 0;
    ticks.push({
      ms: t.toMillis(),
      major,
      label: major
        ? t.toFormat('HH:mm')
        : null,
    });
    t = t.plus({ hours: 1 });
    i++;
  }
  void i;
  return ticks;
}

/** 站点时区下的今天日期字符串 YYYY-MM-DD */
export function todayInZone(timezone: string): string {
  return DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd');
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}
