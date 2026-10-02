/** Format an ISO timestamp as a compact, local relative time. */
export function formatRelativeTime(isoTime: string, now: number | Date = Date.now()): string {
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return isoTime;

  const clock = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(clock)) return new Date(timestamp).toLocaleDateString();

  const age = clock - timestamp;
  if (age < 60_000) return "just now";
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)} min ago`;
  if (age < 24 * 60 * 60_000) return `${Math.floor(age / (60 * 60_000))} h ago`;
  return new Date(timestamp).toLocaleDateString();
}
