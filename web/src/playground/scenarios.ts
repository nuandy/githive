import type { RepoSnapshot } from "../api";
import type { Rand } from "./random";
import { expressFiles, monorepoFiles } from "./trees";

// The playground's scenarios: who arrives when, what each sets out to do, the backlog they share, and the few turns
// a story must take (a rejection, a question for a person, a failed batch). The simulator plays them; everything
// else (reviewers, verdicts, timings, who wins a race for an item) comes from the seed.

export type ScenarioName = "mixed" | "swarm" | "quiet-burst" | "first-agent" | "big-repo";

export const SCENARIOS: { name: ScenarioName; title: string; description: string }[] = [
	{
		name: "mixed",
		title: "Mixed hive",
		description:
			"Eight agents from several owners on an Express-shaped repo: features, fixes, a refactor, tests and a dependency " +
			"bump. A rejection, a question for a person, a security vote only a person can give, a release and a failed batch.",
	},
	{
		name: "swarm",
		title: "Swarm",
		description:
			"Twenty agents and 27 backlog items, each adding edge-case tests for one file in test/, the shape of the Express " +
			"run. They pile onto the same items at first; one wins each.",
	},
	{
		name: "quiet-burst",
		title: "Quiet, then a burst",
		description: "Four goals that all land, three hours of nothing, then a second burst. Step skips the quiet.",
	},
	{
		name: "first-agent",
		title: "First agent",
		description: "An empty hive. One agent arrives after half a minute and takes one goal through to landing.",
	},
	{
		name: "big-repo",
		title: "Big repo",
		description:
			"About 2,000 files in a monorepo, and twelve agents spread over its packages, apps, services and docs.",
	},
];

/** The turns a goal's story takes, beyond building, review and landing. */
export interface Fate {
	/** What its first reviews reject it with, one per review, before one approves. */
	rejections?: string[];
	/** What the reviewer who approves it says. */
	approval?: string;
	/** Never rejected by chance. */
	clean?: boolean;
	/** Its first batch fails the checks, with this at the end of their output. */
	failsChecks?: string;
	/** A question its agent puts to a person once it has pushed, and what the person says to each answer. */
	asks?: { question: string; yes: string; no: string };
	/** It gives up this many minutes after claiming, saying why. */
	releases?: { afterMinutes: number; why: string };
	/** Its agent claims more paths this many minutes in. */
	widens?: { afterMinutes: number; paths: string[] };
	/** When it pushes, GitHive tells it and another open change that each alters a name the other uses. */
	headsUp?: { change: string; names: string };
}

/** Something an agent sets out to do: a goal of its own, or (with a title) a backlog item. */
export interface GoalPlan {
	change: string;
	intent: string;
	paths: string[];
	/** Files it adds, which appear in the tree once it lands. */
	creates?: string[];
	/** Minutes its first push takes; otherwise the scenario's range. */
	buildMinutes?: number;
	/** Not before this many minutes from the start: the agent comes back for it. */
	notBefore?: number;
	/** For a hosted builder's goal: whose agent asked GitHive to build it. */
	requestedBy?: string;
	fate?: Fate;
}

export interface BacklogPlan extends GoalPlan {
	title: string;
	after?: string[];
}

export interface AgentPlan {
	name: string;
	/** Whose agent it is, for keeping a person's agents from reviewing each other. Defaults to the name's first word. */
	owner?: string;
	/** One of GitHive's hosted builders: it builds the goals it's given and nothing else. */
	hosted?: boolean;
	/** Minutes after the start. */
	arrives: number;
	/** Goals of its own, in order. */
	goals?: GoalPlan[];
	/** A backlog item it reaches for first, how soon after arriving, and how its claim goes if it wins it. */
	reach?: { item: string; afterSeconds: number; fate?: Fate };
}

/** What reviewers, the checks and people say, worded for the repo at hand. */
export interface Voices {
	approve(goal: GoalPlan, rand: Rand): string;
	reject(goal: GoalPlan, rand: Rand): string;
	/** The end of the checks' output, for a change that fails them by chance. */
	checksOutput(goal: GoalPlan, rand: Rand): string;
	/** GitHive's security reviewer, approving a dependency change. */
	security(goal: GoalPlan, rand: Rand): string;
	/** A person's vote in a role, for a change that waits on one. */
	person(role: string, verdict: "approve" | "reject"): string;
}

export interface ScenarioPlan {
	name: ScenarioName;
	repo: string;
	policy: RepoSnapshot["policy"];
	verify: string[];
	files: string[];
	agents: AgentPlan[];
	backlog: BacklogPlan[];
	/** Who put the backlog together. */
	backlogBy: string;
	/** Minutes before the start that it was put together. */
	backlogAge: number;
	/** Minutes a first push takes, unless a goal says. */
	build: [number, number];
	/** The chance a change's first review rejects it, unless its fate says. */
	rejectRate: number;
	/** The chance a change fails the checks the first time it's batched, unless its fate says. */
	failRate: number;
	/** The chance an agent reaches for the first free item rather than one in its own order, so a crowd collides. */
	crowd: number;
	voices: Voices;
}

/** The person who owns the playground's repos: adds the backlog, answers questions, holds the security role. */
export const PERSON = "person:5c1e9a7b20d4";

const DEPENDENCY_FILES = ["package.json", "package-lock.json"];

export function scenarioPlan(name: ScenarioName, rand: Rand): ScenarioPlan {
	switch (name) {
		case "mixed":
			return mixed(rand);
		case "swarm":
			return swarm(rand);
		case "quiet-burst":
			return quietBurst(rand);
		case "first-agent":
			return firstAgent();
		case "big-repo":
			return bigRepo(rand);
	}
}

// Express: the voices.

const firstTest = (goal: GoalPlan) =>
	goal.paths.find((path) => path.startsWith("test/") && path.endsWith(".js")) ?? "test/app.js";
const firstSource = (goal: GoalPlan) => goal.paths.find((path) => !path.startsWith("test/")) ?? goal.paths[0] ?? "lib/";
const passing = (rand: Rand, base: number) => `${(base + rand.int(0, 40)).toLocaleString("en-US")} passing`;

const EXPRESS_VOICES: Voices = {
	approve(goal, rand) {
		const extra = rand.pick([
			"the new cases fail on main and pass here",
			"lint is clean, and no new dependencies",
			"tried it by hand against examples/hello-world",
			"read every changed line; History.md has an entry",
			"checked HEAD and OPTIONS requests behave the same as before",
		]);
		return `npm test: ${passing(rand, 1190)} (${rand.int(2, 5)}s). Read the diff of ${firstSource(goal)}; ${extra}.`;
	},
	reject(goal, rand) {
		const test = firstTest(goal);
		const source = firstSource(goal);
		const line = rand.int(40, 220);
		return rand.pick([
			`npm run lint: ${source}:${line}:7 'Buffer' is not defined (no-undef). The file runs in the browser bundle too.`,
			`npm test: 1 failing. ${test}: expected 200 "OK", got 500 "Internal Server Error" when the handler throws synchronously.`,
			`${source} line ${line}: the early return skips res.end() for HEAD requests, so they hang. Repro: curl -I localhost:3000/`,
			`The new tests in ${test} pass on main too, so they don't test the change; at least one should fail without it.`,
			`${source} line ${line}: adds a required argument to a public method. Express 4 can't take that in a minor release.`,
		]);
	},
	checksOutput(goal, rand) {
		const test = firstTest(goal);
		return (
			`  ${passing(rand, 1180)} (3s)\n  1 failing\n\n  1) ${test.replace(/^test\/|\.js$/g, "")}\n` +
			`       should keep the existing behaviour:\n     Error: expected 200 "OK", got 404 "Not Found"\n` +
			`      at Context.<anonymous> (${test}:${rand.int(20, 300)}:${rand.int(5, 30)})`
		);
	},
	security(_goal, rand) {
		return (
			`Read package-lock.json's diff: ${rand.int(2, 4)} packages moved, all from registry.npmjs.org with matching ` +
			`integrity hashes. npm audit: 0 vulnerabilities. No install scripts added.`
		);
	},
	person(role, verdict) {
		if (role === "security")
			return verdict === "approve"
				? "Read the lockfile diff myself: registry tarballs only, integrity hashes match, nothing with install scripts."
				: "body-parser 1.20.3 drops Node 0.10 support, and Express 4 still promises it. Bump qs alone.";
		return verdict === "approve" ? "Looked at it from the dashboard; fine to land." : "Not like this: see my note.";
	},
};

// Express: the mixed hive.

function mixed(rand: Rand): ScenarioPlan {
	const jitter = () => rand.int(0, 3) / 60;
	const forager = `build-examples-rate-limi-${rand.hex(4)}`;
	const nurse = `write-acceptance-tests-f-${rand.hex(4)}`;
	return {
		name: "mixed",
		repo: "playground/express",
		policy: {
			required: 1,
			vetoes: [],
			escalate: [{ paths: DEPENDENCY_FILES, vetoes: ["security"] }],
			grants: { security: ["person:*"] },
		},
		verify: ["npm test"],
		files: expressFiles(),
		backlogBy: PERSON,
		backlogAge: 25,
		build: [2, 8],
		rejectRate: 0.15,
		failRate: 0,
		crowd: 0.2,
		voices: EXPRESS_VOICES,
		agents: [
			{
				name: "alice-claude",
				arrives: 0.2 + jitter(),
				goals: [
					{
						change: "fix-ipv6-host",
						intent:
							"Fix req.hostname for IPv6 hosts. `[::1]:3000` comes back as `[` because the port is cut at the " +
							"first colon; strip the port only after the closing bracket.",
						paths: ["lib/request.js", "test/req.hostname.js"],
						buildMinutes: 4,
						fate: {
							rejections: [
								"npm test: 1 failing. req.hostname should strip the port from an IPv6 host: expected '[::1]', " +
									"got '[::1]:3000'. The bracket branch returns before the port is cut. Tried [::1] and [::1]:3000 " +
									"against examples/hello-world.",
							],
							approval:
								"npm test: 1,208 passing (3s). Tried [::1], [::1]:3000, example.com and example.com:8080 against " +
								"examples/hello-world: all four come back right, and X-Forwarded-Host still wins with trust proxy on.",
						},
					},
					{
						change: "router-options-tests",
						intent:
							"Add tests that `case sensitive routing` and `strict routing` set on the app don't reach routers " +
							"mounted with app.use, since a Router takes its own options.",
						paths: ["test/app.router.js"],
					},
				],
			},
			{
				name: "bob-codex",
				arrives: 0.55 + jitter(),
				reach: {
					item: "etag-weak",
					afterSeconds: 4,
					fate: { widens: { afterMinutes: 2.5, paths: ["test/res.send.js"] } },
				},
				goals: [
					{
						change: "view-lookup-once",
						intent:
							"Refactor View#lookup in lib/view.js to stat each root once with the default extension, instead " +
							"of twice for every candidate path.",
						paths: ["lib/view.js", "test/app.render.js"],
					},
				],
			},
			{
				name: "agent-12",
				arrives: 0.62 + jitter(),
				reach: { item: "etag-weak", afterSeconds: 11 },
				goals: [
					{
						change: "options-allow-dedupe",
						intent:
							"Answer OPTIONS with an Allow header that lists each method once, sorted, even when several " +
							"routes match the path.",
						paths: ["lib/router/index.js", "test/app.options.js"],
						buildMinutes: 6,
					},
				],
			},
			{
				name: "githive-forager",
				hosted: true,
				arrives: 1.3,
				goals: [
					{
						change: forager,
						requestedBy: "carol-claude",
						intent:
							"Build examples/rate-limit/index.js: a small app showing how to rate-limit an API with plain " +
							"middleware and no extra dependency. Keep a Map of client IPs to request timestamps, allow 10 " +
							"requests a minute per IP, answer the 11th with 429 and a Retry-After header in seconds, and let " +
							"/health through unlimited. Mount it the way examples/web-service mounts its API key check, so the " +
							"two read alike, and add test/acceptance/rate-limit.js covering the 10th request passing, the 11th " +
							"getting 429 with Retry-After, and /health never being limited.",
						paths: ["examples/rate-limit/", "test/acceptance/rate-limit.js"],
						creates: ["examples/rate-limit/index.js", "test/acceptance/rate-limit.js"],
						buildMinutes: 6,
						fate: { clean: true },
					},
				],
			},
			{
				name: "carol-claude",
				arrives: 2.1 + jitter(),
				goals: [
					{
						change: "bump-qs",
						intent:
							"Bump qs to 6.13.0 and body-parser to 1.20.3: qs 6.11 lets `a[__proto__][x]=1` in a query " +
							"string reach the object's prototype.",
						paths: DEPENDENCY_FILES,
						buildMinutes: 3,
						fate: {
							clean: true,
							approval:
								"npm ci && npm test: 1,204 passing (4s). package-lock.json moves qs 6.11.0 to 6.13.0 and " +
								"body-parser 1.20.2 to 1.20.3, nothing else. ?a[__proto__][x]=1 no longer reaches the prototype.",
						},
					},
				],
			},
			{
				name: "dave-cursor",
				arrives: 2.9 + jitter(),
				goals: [
					{
						change: "layer-regexp-cache",
						intent:
							"Refactor lib/router/layer.js to compile each path's regexp once and reuse it, instead of " +
							"rebuilding it whenever app.param() is added.",
						paths: ["lib/router/layer.js", "lib/router/route.js"],
						buildMinutes: 4.5,
						fate: {
							clean: true,
							asks: {
								question:
									"Layer's regexp property is public, and examples/route-map reads it. Is it fine to make it a " +
									"getter that compiles on first use, or must it stay a plain property?",
								yes: "Make it a getter. Nothing outside the router should read it; say so in History.md.",
								no: "Keep it a plain property: plugins read layer.regexp directly. Cache beside it instead.",
							},
							headsUp: { change: "options-allow-dedupe", names: "Layer.prototype.match" },
						},
					},
				],
			},
			{
				name: "githive-nurse",
				hosted: true,
				arrives: 2.6,
				goals: [
					{
						change: nurse,
						requestedBy: "dave-cursor",
						intent:
							"Write acceptance tests for examples/content-negotiation in " +
							"test/acceptance/content-negotiation.js: the example answers GET / and GET /users with HTML, plain " +
							"text or JSON depending on the Accept header, through res.format() in index.js and users.js. Cover " +
							"each of the three types on both routes, a request with no Accept header (which should get the " +
							"first format listed, HTML), and one asking only for image/png, which should get 406 Not " +
							"Acceptable. Use supertest as the other acceptance tests do, and don't change the example itself.",
						paths: ["test/acceptance/content-negotiation.js"],
						creates: ["test/acceptance/content-negotiation.js"],
						buildMinutes: 3.5,
						fate: {
							clean: true,
							failsChecks:
								"  1,211 passing (3s)\n  1 failing\n\n  1) content-negotiation\n       GET /\n" +
								"         should default to HTML when there is no Accept header:\n" +
								'     Error: expected "Content-Type" matching /html/, got "text/plain; charset=utf-8"\n' +
								"      at Test._assertHeader (node_modules/supertest/lib/test.js:249:12)",
						},
					},
				],
			},
			{
				name: "erin-codex",
				arrives: 4.4 + jitter(),
				reach: {
					item: "static-maxage",
					afterSeconds: 6,
					fate: {
						releases: {
							afterMinutes: 4.2,
							why:
								"send 1.1 changes how maxAge is read, and examples/static-files depends on the old way; giving " +
								"this up until send 1.1 is out rather than doing it twice.",
						},
					},
				},
				goals: [
					{
						change: "trust-proxy-example",
						intent:
							"Add examples/trust-proxy: an app behind a proxy that shows req.ip, req.ips and req.protocol with " +
							"trust proxy set to a hop count, a subnet and a function.",
						paths: ["examples/trust-proxy/"],
						creates: ["examples/trust-proxy/index.js"],
					},
				],
			},
		],
		backlog: [
			{
				change: "etag-weak",
				title: "Weak ETags for empty bodies",
				intent:
					"Generate weak ETags for empty bodies too when app.set('etag', 'weak') is on; res.send('') skips the " +
					"ETag entirely today.",
				paths: ["lib/utils.js", "test/utils.js"],
			},
			{
				change: "static-maxage",
				title: "res.sendFile: maxAge as a string",
				intent:
					"Let res.sendFile take maxAge as a string like '1d' or '2h', as express.static does, instead of " +
					"treating it as 0.",
				paths: ["lib/response.js", "test/res.sendFile.js"],
			},
			{
				change: "json-escape-tests",
				title: "Tests for json escape",
				intent:
					"Add tests for app.set('json escape') in res.json and res.jsonp: <, > and & in strings, and that it " +
					"stays off by default.",
				paths: ["test/res.json.js", "test/res.jsonp.js"],
			},
			{
				change: "bench-error-handler",
				title: "Benchmark next(err)",
				intent:
					"Add a benchmark for an app whose 50 middleware end in an error handler, to see what next(err) costs " +
					"on each request.",
				paths: ["benchmarks/"],
				creates: ["benchmarks/error-handler.js"],
			},
			{
				change: "session-resave",
				title: "Examples: resave: false",
				intent:
					"Set resave: false and saveUninitialized: false in examples/session and examples/auth, which " +
					"express-session warns about on start.",
				paths: ["examples/session/", "examples/auth/"],
			},
			{
				change: "vary-dedupe",
				title: "res.vary: skip a field in any case",
				intent:
					"Make res.vary() skip a field that's already in Vary whatever its case, so Accept and accept aren't " +
					"both sent.",
				paths: ["lib/response.js", "test/res.vary.js"],
			},
			{
				change: "download-headers-tests",
				title: "Tests for res.download's headers",
				intent:
					"Add tests that res.download keeps headers set before it, and that options.headers can't override " +
					"Content-Disposition.",
				paths: ["test/res.download.js"],
			},
			{
				change: "query-parser-case",
				title: "Query parser setting in any case",
				intent:
					"Accept 'Extended' and 'SIMPLE' for the query parser setting, as the docs' examples spell them, " +
					"instead of throwing on start.",
				paths: ["lib/utils.js", "test/config.js"],
			},
		],
	};
}

// Express: the swarm. Each item adds edge-case tests for one method, in a file of its own in test/.

const SWARM_ITEMS: [id: string, file: string, subject: string, cases: string][] = [
	["links-edges", "res.links", "res.links()", "an empty object, a rel with spaces, and two calls in a row"],
	["type-edges", "res.type", "res.type()", "a bare extension, an unknown type, and a type that has a charset already"],
	[
		"location-edges",
		"res.location",
		"res.location()",
		"'back' with no Referer, a URL with spaces, a protocol-relative URL",
	],
	[
		"hostname-edges",
		"req.hostname",
		"req.hostname",
		"IPv6 with and without a port, an empty Host, two X-Forwarded-Hosts",
	],
	["is-edges", "req.is", "req.is()", "no body, a wildcard subtype, and a type with parameters"],
	["vary-edges", "res.vary", "res.vary()", "an empty field, a field in another case, and '*'"],
	[
		"attachment-edges",
		"res.attachment",
		"res.attachment()",
		"a unicode filename, a path with folders, and no filename",
	],
	["cookie-edges", "res.cookie", "res.cookie()", "maxAge of 0, a signed cookie without a secret, and an object value"],
	["format-edges", "res.format", "res.format()", "no Accept header, a default callback, and q-values that tie"],
	["get-edges", "req.get", "req.get()", "Referer and Referrer, a header in another case, and no name at all"],
	["json-edges", "res.json", "res.json()", "undefined, a BigInt, and the json escape setting"],
	[
		"jsonp-edges",
		"res.jsonp",
		"res.jsonp()",
		"a callback with odd characters, an array of callbacks, U+2028 in the body",
	],
	[
		"redirect-edges",
		"res.redirect",
		"res.redirect()",
		"a status as the second argument, HEAD requests, HTML in the URL",
	],
	["send-edges", "res.send", "res.send()", "a Buffer with a Content-Type already set, null, and a number as the body"],
	["send-status-edges", "res.sendStatus", "res.sendStatus()", "an unknown code, 204, and a code outside 100 to 999"],
	["set-edges", "res.set", "res.set()", "an array value, Content-Type with a charset, and an object of headers"],
	["status-edges", "res.status", "res.status()", "a string code, 0, and a float"],
	["append-edges", "res.append", "res.append()", "Set-Cookie after res.cookie(), an array, and an empty value"],
	["clear-cookie-edges", "res.clearCookie", "res.clearCookie()", "a path option, a maxAge passed in, a signed cookie"],
	["accepts-edges", "req.accepts", "req.accepts()", "no Accept header, an array of types, and a bare extension"],
	["accepts-languages-edges", "req.acceptsLanguages", "req.acceptsLanguages()", "a wildcard, a region, and no header"],
	["range-edges", "req.range", "req.range()", "an unsatisfiable range, several ranges with combine, and no size"],
	["query-edges", "req.query", "req.query", "the simple parser with arrays, the parser turned off, a very deep object"],
	["protocol-edges", "req.protocol", "req.protocol", "two X-Forwarded-Proto values, trust proxy off, and a TLS socket"],
	[
		"secure-edges",
		"req.secure",
		"req.secure",
		"behind a trusted proxy, behind an untrusted one, and over TLS directly",
	],
	["subdomains-edges", "req.subdomains", "req.subdomains", "an IP address as the host, an offset of 0, a trailing dot"],
	["fresh-edges", "req.fresh", "req.fresh", "a weak ETag, If-None-Match: *, and a POST request"],
];

const SWARM_VOICES: Voices = {
	...EXPRESS_VOICES,
	approve(goal, rand) {
		const file = goal.paths[0] ?? "test/";
		return (
			`npm test: ${passing(rand, 1210)} (${rand.int(3, 6)}s), ${rand.int(3, 9)} of them new in ${file}. ` +
			rand.pick([
				"Each new case fails with the method stubbed out, so they test something.",
				"Ran the file alone with --grep too; no shared state between cases.",
				"Read every case against the method's source; the expectations match what it does.",
			])
		);
	},
	reject(goal, rand) {
		const file = goal.paths[0] ?? "test/";
		const line = rand.int(12, 90);
		return rand.pick([
			`${file}:${line}: the third case asserts nothing; it ends the response without checking the header.`,
			`${file} listens on port 3000; the other tests use supertest's own server, and this one fails when run in parallel.`,
			`npm run lint: ${file}:${line}:3 it.only left in, which skips the rest of the suite.`,
			`${file}: two cases copy test/${file.replace(/^test\/|\.edges\.js$/g, "")}.js word for word; they add nothing.`,
		]);
	},
};

function swarm(rand: Rand): ScenarioPlan {
	const agents: AgentPlan[] = [];
	for (let n = 1; n <= 20; n++) agents.push({ name: `agent-${n}`, arrives: (n - 1) * 0.06 + rand.int(0, 8) / 60 });
	return {
		name: "swarm",
		repo: "playground/express",
		policy: { required: 1, vetoes: [] },
		verify: ["npm test"],
		files: expressFiles(),
		backlogBy: PERSON,
		backlogAge: 12,
		build: [2, 5],
		rejectRate: 0.18,
		failRate: 0.04,
		crowd: 0.55,
		voices: SWARM_VOICES,
		agents,
		backlog: SWARM_ITEMS.map(([id, file, subject, cases]) => ({
			change: id,
			title: `Edge-case tests for ${subject}`,
			intent: `Add edge-case tests for ${subject} in test/${file}.edges.js: ${cases}.`,
			paths: [`test/${file}.edges.js`],
			creates: [`test/${file}.edges.js`],
		})),
	};
}

// Express: a burst, three hours of quiet, and another burst.

function quietBurst(rand: Rand): ScenarioPlan {
	const second = 195;
	return {
		name: "quiet-burst",
		repo: "playground/express",
		policy: { required: 1, vetoes: [] },
		verify: ["npm test"],
		files: expressFiles(),
		backlogBy: PERSON,
		backlogAge: 30,
		build: [2, 6],
		rejectRate: 0.2,
		failRate: 0,
		crowd: 0,
		voices: EXPRESS_VOICES,
		agents: [
			{
				name: "kim-claude",
				arrives: 0.1,
				goals: [
					{
						change: "redirect-back-empty-referer",
						intent:
							"Make res.redirect('back') go to / when the Referer header is empty, rather than redirecting to " +
							"an empty Location.",
						paths: ["lib/response.js", "test/res.redirect.js"],
					},
					{
						change: "jsonp-json-spaces",
						intent: "Honour app.set('json spaces') in res.jsonp the way res.json does.",
						paths: ["lib/response.js", "test/res.jsonp.js"],
						notBefore: second,
					},
				],
			},
			{
				name: "lee-codex",
				arrives: 0.4 + rand.int(0, 10) / 60,
				goals: [
					{
						change: "subdomains-offset-tests",
						intent:
							"Add tests for req.subdomains with the subdomain offset set to 0, and to more labels than the " +
							"host has.",
						paths: ["test/req.subdomains.js"],
					},
				],
			},
			{
				name: "githive-forager",
				hosted: true,
				arrives: 0.8,
				goals: [
					{
						change: `set-cache-headers-in-exa-${rand.hex(4)}`,
						requestedBy: "kim-claude",
						intent:
							"Set cache headers in examples/static-files: serve public/css and public/js with a one-year " +
							"max-age and immutable, since their names would change with their content in a real app, and " +
							"public/hello.txt with no-cache so edits show at once. Use express.static's setHeaders option " +
							"rather than a middleware of its own, keep the example's three mounts as they are, and explain " +
							"the two policies in a short comment above them. Extend test/acceptance/static-files.js to " +
							"check the Cache-Control header of one file from each folder.",
						paths: ["examples/static-files/", "test/acceptance/static-files.js"],
						creates: ["test/acceptance/static-files.js"],
					},
				],
			},
			{
				name: "agent-31",
				arrives: 1.2 + rand.int(0, 10) / 60,
				goals: [
					{
						change: "mvc-boot-once",
						intent:
							"Refactor examples/mvc/lib/boot.js to read the controllers folder once at start, instead of " +
							"on every mount.",
						paths: ["examples/mvc/"],
					},
				],
			},
			{
				name: "noah-cursor",
				arrives: second + 0.5,
				goals: [
					{
						change: "param-array-tests",
						intent: "Add tests for app.param() given an array of names, and for a param callback that throws.",
						paths: ["test/app.param.js"],
					},
				],
			},
			{
				name: "githive-nurse",
				hosted: true,
				arrives: second + 1,
				goals: [
					{
						change: `add-an-examples-gracefu-${rand.hex(4)}`,
						requestedBy: "noah-cursor",
						intent:
							"Add an examples/graceful-shutdown app: a server that, on SIGTERM, stops accepting new " +
							"connections, lets requests in flight finish for up to 10 seconds, closes keep-alive sockets " +
							"once they go idle, and exits with 0, or with 1 if it had to cut requests off. Log each step " +
							"with console.log so a reader can follow it in a terminal, keep it to plain Node and Express " +
							"with no extra dependency, and add test/acceptance/graceful-shutdown.js that starts the app, " +
							"holds a slow request open, sends SIGTERM and checks the request still completes.",
						paths: ["examples/graceful-shutdown/", "test/acceptance/graceful-shutdown.js"],
						creates: ["examples/graceful-shutdown/index.js", "test/acceptance/graceful-shutdown.js"],
					},
				],
			},
		],
		backlog: [],
	};
}

// Express: one agent in an empty hive.

function firstAgent(): ScenarioPlan {
	return {
		name: "first-agent",
		repo: "playground/express",
		policy: { required: 1, vetoes: [] },
		verify: ["npm test"],
		files: expressFiles(),
		backlogBy: PERSON,
		backlogAge: 0,
		build: [3, 5],
		rejectRate: 0,
		failRate: 0,
		crowd: 0,
		voices: EXPRESS_VOICES,
		agents: [
			{
				name: "maya-claude",
				arrives: 0.5,
				goals: [
					{
						change: "healthz-route",
						intent:
							"Add a /healthz route to examples/hello-world that answers 200 with the process uptime, for " +
							"container health checks.",
						paths: ["examples/hello-world/index.js", "test/acceptance/hello-world.js"],
						buildMinutes: 4,
						fate: {
							clean: true,
							approval:
								'npm test: 1,206 passing (3s). GET /healthz answers 200 with {"uptime":…} and GET / still says ' +
								"Hello World; no new dependencies.",
						},
					},
				],
			},
		],
		backlog: [],
	};
}

// A monorepo of about 2,000 files, and twelve agents in different parts of it.

const pkgOf = (goal: GoalPlan) => /^(?:packages|apps|services)\/([^/]+)/.exec(goal.paths[0] ?? "")?.[1] ?? "workspace";

const MONOREPO_VOICES: Voices = {
	approve(goal, rand) {
		const extra = rand.pick([
			"pnpm typecheck is clean",
			"read every changed line against the ticket's examples",
			"ran the new tests 20 times with --repeat; no flakes",
			"checked the migration runs forward and back on a copy of staging",
			"no new dependencies; bundle size unchanged",
		]);
		return `pnpm test --filter @hive/${pkgOf(goal)}: ${rand.int(80, 640)} passing (${rand.int(4, 40)}s); ${extra}.`;
	},
	reject(goal, rand) {
		const file = goal.paths.find((path) => /\.tsx?$/.test(path)) ?? `${goal.paths[0] ?? ""}index.ts`;
		const line = rand.int(20, 260);
		return rand.pick([
			`pnpm typecheck: ${file}:${line}:${rand.int(5, 40)} TS2345: Argument of type 'string | undefined' is not ` +
				`assignable to parameter of type 'string'.`,
			`pnpm test --filter @hive/${pkgOf(goal)}: 1 failing. The new case passes only in UTC; with TZ=America/Denver ` +
				`it's off by a day.`,
			`${file} line ${line}: the retry loop never awaits the delay, so all six attempts go out in the same millisecond.`,
			`${file}: logs the whole request at info level, Authorization header included.`,
		]);
	},
	checksOutput(goal, rand) {
		return (
			`@hive/${pkgOf(goal)}:test: FAIL test/${pkgOf(goal)}.test.ts > handles an empty page\n` +
			`@hive/${pkgOf(goal)}:test: AssertionError: expected [] to deeply equal [ { id: 'p_1' } ]\n` +
			` Tasks:    ${rand.int(30, 40)} successful, 1 failed`
		);
	},
	security(_goal, rand) {
		return (
			`pnpm audit: 0 vulnerabilities. pnpm-lock.yaml moves ${rand.int(3, 9)} packages, all from the npm registry ` +
			`with matching integrity; no new install scripts, no git or tarball URLs.`
		);
	},
	person(role, verdict) {
		if (role === "security")
			return verdict === "approve"
				? "Read the lockfile diff: registry packages only, integrity matches."
				: "Pulls a package from a git URL; use the published release.";
		return verdict === "approve" ? "Fine by me, go ahead." : "Not tonight: do it with the replica swap.";
	},
};

function bigRepo(rand: Rand): ScenarioPlan {
	const at = (minutes: number) => minutes + rand.int(0, 20) / 60;
	const agent = (name: string, arrives: number, goal: GoalPlan, more: Partial<AgentPlan> = {}): AgentPlan => ({
		name,
		arrives: at(arrives),
		goals: [goal],
		...more,
	});
	return {
		name: "big-repo",
		repo: "playground/monorepo",
		policy: {
			required: 1,
			vetoes: [],
			escalate: [{ paths: ["package.json", "pnpm-lock.yaml"], vetoes: ["security"] }],
			grants: { security: ["githive"] },
		},
		verify: ["pnpm test"],
		files: monorepoFiles(),
		backlogBy: PERSON,
		backlogAge: 90,
		build: [3, 8],
		rejectRate: 0.2,
		failRate: 0.05,
		crowd: 0.1,
		voices: MONOREPO_VOICES,
		agents: [
			agent("alice-claude", 0.1, {
				change: "prorate-plan-changes",
				intent:
					"Prorate invoices when a customer changes plan mid-cycle: credit the unused days of the old plan on " +
					"the next invoice instead of charging both in full.",
				paths: ["packages/billing/src/proration/", "packages/billing/test/proration.test.ts"],
			}),
			agent("bob-codex", 0.4, {
				change: "projects-cursor-pagination",
				intent:
					"Add cursor pagination to GET /v1/projects; offset pagination times out past page 400 for the biggest " +
					"accounts.",
				paths: [
					"services/api/src/routes/projects.ts",
					"services/api/src/models/projects.ts",
					"services/api/test/routes/projects.test.ts",
				],
			}),
			agent("carol-claude", 0.8, {
				change: "datepicker-utc-shift",
				intent:
					"Fix DatePicker in apps/web jumping a day back for anyone west of UTC: it builds dates with " +
					"new Date('YYYY-MM-DD'), which is midnight UTC.",
				paths: ["apps/web/src/components/DatePicker/"],
				fate: { widens: { afterMinutes: 2, paths: ["packages/i18n/src/dates/"] } },
			}),
			agent("dave-cursor", 1.2, {
				change: "staging-db-private-subnet",
				intent:
					"Move the staging database into the private subnets and drop its public IP; only the api and worker " +
					"security groups may reach 5432.",
				paths: ["infra/terraform/staging/"],
				fate: {
					clean: true,
					asks: {
						question:
							"Terraform plans to replace the staging database instance (destroy, then create), about 10 " +
							"minutes of staging downtime. Is tonight fine, or should I do it with a replica swap?",
						yes: "Tonight is fine; post in #staging before you apply.",
						no: "Not tonight: do it with the replica swap.",
					},
				},
			}),
			agent("erin-codex", 1.7, {
				change: "indexer-batch-writes",
				intent:
					"Refactor the search indexer to write documents in batches of 500 instead of one request each; " +
					"reindexing the biggest account takes 40 minutes now.",
				paths: ["packages/search/src/indexer/", "packages/search/test/indexer.test.ts"],
			}),
			agent("frank-claude", 2.2, {
				change: "docs-local-worker",
				intent:
					"Write a guide to running the worker locally against the queue emulator, from docker compose up to " +
					"watching a webhook retry.",
				paths: ["docs/guides/local-worker.md", "docs/guides/local-development.md"],
				creates: ["docs/guides/local-worker.md"],
			}),
			agent(
				"mira/agent-7",
				2.6,
				{
					change: "webhook-backoff",
					intent:
						"Retry failed webhook deliveries with exponential backoff and jitter, capped at 6 attempts, then " +
						"mark the delivery dead.",
					paths: ["services/worker/src/jobs/send-webhooks.ts", "services/worker/test/jobs/send-webhooks.test.ts"],
				},
				{ owner: "mira" },
			),
			agent("agent-19", 3.1, {
				change: "pt-br-onboarding",
				intent: "Add Brazilian Portuguese translations for onboarding, common words and error messages.",
				paths: ["packages/i18n/locales/pt-BR/"],
				creates: [
					"packages/i18n/locales/pt-BR/common.json",
					"packages/i18n/locales/pt-BR/errors.json",
					"packages/i18n/locales/pt-BR/onboarding.json",
				],
			}),
			agent(
				"githive-scout",
				3.5,
				{
					change: `upgrade-typescript-to-5-${rand.hex(4)}`,
					requestedBy: "bob-codex",
					intent:
						"Upgrade TypeScript to 5.9 across the workspace: bump typescript in the root package.json, " +
						"regenerate pnpm-lock.yaml with pnpm install, and fix what the stricter checks find. Expect the new " +
						"checks on unused type parameters and on narrowing through destructured discriminants to flag a few " +
						"places in packages/core and packages/billing; fix them in place rather than turning the checks " +
						"off. Don't touch tsconfig.base.json's target or module settings, and leave the generated clients " +
						"in packages/clients alone, since codegen rewrites them.",
					paths: ["package.json", "pnpm-lock.yaml", "packages/core/src/result/", "packages/billing/src/invoices/"],
					buildMinutes: 7,
				},
				{ hosted: true },
			),
			agent(
				"githive-waggle",
				4,
				{
					change: `add-an-audit-log-page-to-${rand.hex(4)}`,
					requestedBy: "hana-claude",
					intent:
						"Add an audit log page to apps/admin at /audit: list the newest 200 entries from GET /v1/audit with " +
						"the actor, the action, the target and the time, newest first, with filters by actor email and by " +
						"action that update the URL so a filtered view can be shared. Reuse the Timeline component for the " +
						"rows and the SearchUsers box for the actor filter, and load more entries as the person scrolls " +
						"instead of paging. Add a test that the filters round-trip through the URL, and register the page " +
						"in the admin's routes.",
					paths: ["apps/admin/src/pages/audit/", "apps/admin/src/routes.ts"],
					creates: [
						"apps/admin/src/pages/audit/index.tsx",
						"apps/admin/src/pages/audit/loader.ts",
						"apps/admin/src/pages/audit/page.test.tsx",
					],
				},
				{ hosted: true },
			),
			agent("gus-cursor", 4.6, {
				change: "rotate-refresh-tokens",
				intent:
					"Rotate refresh tokens on every use, and revoke the whole token family when a used one comes back, " +
					"which means it leaked.",
				paths: ["packages/auth/src/tokens/", "packages/auth/test/tokens.test.ts"],
			}),
			agent("hana-claude", 5.2, {
				change: "notification-digest",
				intent:
					"Group notification emails sent within 5 minutes of each other into one digest, so a bulk import " +
					"stops sending 300 emails.",
				paths: ["services/notifications/src/jobs/digest.ts", "services/notifications/test/jobs/digest.test.ts"],
				fate: { headsUp: { change: "webhook-backoff", names: "enqueueWithDelay" } },
			}),
		],
		backlog: [
			{
				change: "logger-redact-auth",
				title: "Redact auth headers in logs",
				intent: "Redact the Authorization and Cookie headers in request logs, in every transport.",
				paths: ["packages/logger/src/redact/", "packages/logger/test/redact.test.ts"],
			},
			{
				change: "gateway-request-id",
				title: "Pass X-Request-Id through the gateway",
				intent: "Pass X-Request-Id through the gateway to every service, making one up when a request has none.",
				paths: ["services/gateway/src/handlers/request-id.ts", "services/gateway/test/handlers/request-id.test.ts"],
			},
			{
				change: "dialog-focus-trap",
				title: "Trap focus in Dialog",
				intent: "Trap focus inside Dialog while it's open, and give it back to the element that opened it on close.",
				paths: ["packages/ui/src/dialog/", "packages/ui/test/dialog.test.ts"],
			},
			{
				change: "dialog-focus-docs",
				title: "Document Dialog's focus rules",
				intent: "Write down Dialog's focus rules in docs/guides/accessibility.md, with the keyboard shortcuts.",
				paths: ["docs/guides/accessibility.md"],
				creates: ["docs/guides/accessibility.md"],
				after: ["dialog-focus-trap"],
			},
			{
				change: "ci-pnpm-cache",
				title: "Cache the pnpm store in CI",
				intent: "Cache the pnpm store in CI, keyed on pnpm-lock.yaml, so installs stop taking two minutes.",
				paths: [".github/workflows/ci.yml"],
			},
		],
	};
}
