// What a Worker's Durable Objects did in a window of time, from Cloudflare's GraphQL Analytics API: requests, wall
// time and active time (what duration is billed on) per class. It signs in with wrangler's own login (`wrangler
// login`), whose token can read analytics; the token is never printed. Analytics lag a few minutes behind.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.cloudflare.com/client/v4";

// Where wrangler keeps its login: macOS, then Linux.
const CONFIGS = [
	join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
	join(homedir(), ".config/.wrangler/config/default.toml"),
	join(homedir(), ".wrangler/config/default.toml"),
];

function wranglerToken() {
	for (const path of CONFIGS) {
		try {
			const token = readFileSync(path, "utf8").match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
			if (token) return token;
		} catch {
			// Not there; try the next.
		}
	}
	throw new Error("no wrangler login found: run `npx wrangler login` (or `npx wrangler whoami` to refresh it)");
}

async function cloudflare(path, init = {}) {
	const response = await fetch(`${API}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${wranglerToken()}`, "Content-Type": "application/json", ...init.headers },
	});
	const body = await response.json();
	if (!response.ok || body.success === false || body.errors?.length)
		throw new Error(`${path}: ${JSON.stringify(body.errors ?? body).slice(0, 300)} (try \`npx wrangler whoami\`)`);
	return body;
}

/** The Durable Object classes of `script` in the account, by namespace id. */
export async function namespacesOf(account, script) {
	const { result } = await cloudflare(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100`);
	return Object.fromEntries(result.filter((each) => each.script === script).map((each) => [each.id, each.class]));
}

const QUERY = `query($account: String!, $start: Time!, $end: Time!, $namespaces: [String!]) {
	viewer { accounts(filter: { accountTag: $account }) {
		invocations: durableObjectsInvocationsAdaptiveGroups(
			limit: 100, filter: { datetime_geq: $start, datetime_leq: $end, namespaceId_in: $namespaces }
		) { sum { requests wallTime } dimensions { namespaceId } }
		periodic: durableObjectsPeriodicGroups(
			limit: 100, filter: { datetime_geq: $start, datetime_leq: $end, namespaceId_in: $namespaces }
		) { sum { activeTime } dimensions { namespaceId } }
	} }
}`;

/** Per class, what `namespaces` (id to class) did from `start` to `end` (ISO times): requests, wall and active ms. */
export async function durableObjectUse(account, namespaces, start, end) {
	const variables = { account, start, end, namespaces: Object.keys(namespaces) };
	const { data } = await cloudflare("/graphql", { method: "POST", body: JSON.stringify({ query: QUERY, variables }) });
	const [usage] = data.viewer.accounts;
	const byClass = {};
	const row = (namespaceId) => (byClass[namespaces[namespaceId]] ??= { requests: 0, wallMs: 0, activeMs: 0 });
	for (const { sum, dimensions } of usage.invocations) {
		row(dimensions.namespaceId).requests += sum.requests;
		row(dimensions.namespaceId).wallMs += Math.round(sum.wallTime / 1000);
	}
	for (const { sum, dimensions } of usage.periodic)
		row(dimensions.namespaceId).activeMs += Math.round(sum.activeTime / 1000);
	return byClass;
}
