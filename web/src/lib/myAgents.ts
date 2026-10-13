import type { Connection, MyAgent } from "../api";
import { timeAgo } from "./relativeTime";

// Your agents, as their page words them: when each was last seen, the apps it signs in from, and every date in one
// form. GitHive records when a token was last used and when an app connected, but not each use of a sign-in, nor (on
// this page's API) where an agent holds claims.

const DAY = 86_400_000;

/** A calendar date, the one form this page writes dates in: "Aug 16, 2026" (in the reader's own order). */
export const calendarDate = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** When something happened: "9 minutes ago" for the last 30 days, then "on Aug 16, 2026". */
export function whenWords(iso: string, now: number): string {
	return now - Date.parse(iso) < 30 * DAY ? timeAgo(iso, now) : `on ${calendarDate(iso)}`;
}

/** When a token stops working: "expires Nov 22, 2026", "expired Oct 8, 2026", or "never expires". */
export function expiryWords(iso: string | null, now: number): string {
	if (!iso) return "never expires";
	return `${Date.parse(iso) <= now ? "expired" : "expires"} ${calendarDate(iso)}`;
}

/** The apps that sign in as an agent. */
export const connectionsOf = (agentId: string, connections: Connection[]) =>
	connections.filter((connection) => connection.agentId === agentId);

/** Apps tied to none of your agents listed (or to one no longer listed): shown on their own. */
export function otherConnections(agents: MyAgent[], connections: Connection[]): Connection[] {
	const listed = new Set(agents.filter((agent) => !agent.revokedAt).map((agent) => agent.id));
	return connections.filter((connection) => !connection.agentId || !listed.has(connection.agentId));
}

/** The last time any of an agent's tokens was used, if one was. */
function lastTokenUse(agent: MyAgent): string | null {
	const used = agent.tokens.map((token) => token.lastUsedAt).filter((at): at is string => !!at);
	return used.length ? used.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

/**
 * An agent's state, in a line: when it was last active, from its tokens; or, when an app signs in as it, when that
 * connected (each use of a sign-in isn't recorded), with a token's last use beside it; or that it isn't connected.
 */
export function agentState(agent: MyAgent, connections: Connection[], now: number): string {
	const used = lastTokenUse(agent);
	const apps = connectionsOf(agent.id, connections);
	if (!apps.length) return used ? `Last active ${whenWords(used, now)}` : "Not connected yet";
	const newest = apps.reduce((a, b) => (Date.parse(a.createdAt) >= Date.parse(b.createdAt) ? a : b));
	const connected = `Connected ${whenWords(newest.createdAt, now)}`;
	return used ? `${connected} · a token used ${whenWords(used, now)}` : connected;
}
