/** Format an epoch-ms instant as HH:mm in the given IANA timezone. */
export function fmtTime(tz: string, ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

export function fmtDateTime(tz: string, ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

/** YYYY-MM-DD of "now" in the given timezone (en-CA gives ISO order). */
export function localDateString(tz: string, d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/** Hour of day (0-24, fractional) in the given timezone, for axis labels. */
export function localHour(tz: string, ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return h + m / 60;
}
