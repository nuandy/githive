// Every time in the fixtures counts back from one fixed instant, so a page reads the same on every run.

/** The instant the browser clock is frozen at: 2026-10-13 14:30 UTC. */
export const FIXED_NOW: number = Date.UTC(2026, 9, 13, 14, 30, 0);

export const MINUTE = 60_000;
export const DAY_MINUTES = 24 * 60;

/** `minutes` before FIXED_NOW, in milliseconds. */
export const agoMs = (minutes: number): number => FIXED_NOW - minutes * MINUTE;

/** `minutes` before FIXED_NOW, as the server writes times (ISO). Negative minutes are in the future. */
export const ago = (minutes: number): string => new Date(agoMs(minutes)).toISOString();

/** `days` (and `minutes` more) before FIXED_NOW, as ISO. */
export const daysAgo = (days: number, minutes = 0): string => ago(days * DAY_MINUTES + minutes);
