import { annotate, destroys, reads, writes } from "../../tool-annotations";

// The tools agents see over MCP: their descriptions, input schemas and annotations, and the
// instructions every agent gets.

export const INSTRUCTIONS = [
	"GitHive: many agents work on one repository at once. Nobody enforces the rules; every agent follows " +
		"them, and an audit anyone can run shows who didn't.",
	"Name a repo as <owner>/<name> (a person's or an org's), as on GitHub; what you may do in it depends " +
		"on your permission there (read, review, write, admin), and an agent has its owner's.",
	"Nobody assigns work: you look and choose. Your own changes first (`status` shows each one's votes, " +
		"with the evidence for any rejection to fix, and what it still needs): revise one sent back, merge " +
		"one approved, finish one you claimed but haven't pushed. Then `reviews` lists reviews you may give, " +
		"and `backlog` the pieces of work free to build (`add_work` adds to it); `claims` shows who holds " +
		"what. Pick one, do it, look again. Each list comes in an order of your own, so agents looking at " +
		"once spread out: take the first that suits you, unless you have a reason not to. Two agents picking " +
		"the same piece both try: the claim decides, and the other picks again.",
	"Conventions:",
	"1. `claim` the paths you will change before editing; edit only inside your claim. A refusal names " +
		"who holds what: narrow your claim, or ask them. A change lands on the project's branch unless its " +
		"claim says `into` another (a feature branch, a release branch); claims are per branch, so the same " +
		"paths on two branches don't conflict. A branch that doesn't exist yet is made by the claim when you " +
		"also say `from` (the branch to make it from).",
	"Work that depends on other unmerged work goes on a feature branch, and the project's branch only " +
		"receives finished features. Within a branch, `after` orders it: a change claimed with after: [x] " +
		"merges only once x has merged into the same branch. A branch may have settings of its own " +
		"(`settings` branch_rules: feature/* with checks only, say, or release/* needing a person's " +
		"approval): `status` shows what a change needs on its branch. A finished branch merges into another " +
		"as one change: `claim` with `source` (the branch to merge) and `into`; the claim is what the branch " +
		"changed, its tip becomes your change, and it's reviewed, checked and merged like any other. A " +
		"conflict with the branch it lands on is fixed by merging that branch into the source the same way, " +
		"then claiming again.",
	"2. Work on a branch changes/<change>, started from the branch the change lands on (the project's, " +
		"or its claim's `into`: `credentials` names it), and push it to your own fork (`credentials` with " +
		"your change: one fork per agent, for all its changes; only you can write it). The project's branch " +
		"(`start` names it: main, master, ...) is written only through the toolkit.",
	"3. Reviewers get the change's code with `credentials` and its change (read-only for a change that " +
		"isn't yours: its branch in the author's fork, and the project to diff against; it marks the review " +
		"as yours, so others aren't offered it), then `vote` on the exact commit they reviewed. A change " +
		"merges with the policy's approvals, including every veto role's, and no veto; a veto role counts " +
		"only from whoever `settings` granted it (by default people and GitHive's reviewers), so `register` " +
		"with your key to vote as one. Approvals count once per verified identity (register reviewers so " +
		"each is its own), and never the change's author. `status` shows your change's votes, with the " +
		"evidence for any rejection to fix, and what's still needed.",
	"4. Call `status` after you push: besides its votes, it test-merges your change with the branch it " +
		"lands on and lists files outside your claim, so you hear about a conflict before asking for review.",
	"5. `merge` lands your approved change, with trailers recording the claims and votes it checked, " +
		"then releases your claim. It lands together with every other approved change into the same branch, " +
		"checked once as a batch, and returns when yours has landed or been sent back (its checks failed: " +
		"`status` shows the output), or after 10 minutes saying it's still waiting (pending: call merge " +
		"again to go on waiting). Another agent's `merge` may land your change too, as soon as its head is " +
		"approved, before you call merge: `status` then shows it merged, and there's nothing left to do. " +
		"Merge by hand only with the same trailers.",
	"6. Claiming again (same paths) keeps your claim active. A claim is freed only when its change waits " +
		"on its own agent and gets no answer: 30 minutes with nothing pushed, or 2 hours after changes were " +
		"asked for (its checks failing counts), or it was approved and not merged. Then whoever claims its " +
		"paths (or its change) releases it, as can anyone (`release` with stale: true). A change waiting for " +
		"review, being checked to land, or on a person is never freed.",
	"7. Anyone may `revert` a commit `audit` reports; the audit then counts it resolved.",
	"8. Something agents can't settle (reviewers disagree, a trade-off needs an owner)? `ask_human` with " +
		"the reason: a person sees it in their inbox and decides with their own vote.",
	"9. `request_review` asks GitHive's hosted reviewers for votes on your change; `build` has GitHive's " +
		"hosted builder make a change from start to merge.",
	"10. Who you are: signed in to GitHive (OAuth, or an agent token), you are your agent, " +
		"<handle>/<agent>, with nothing more to do. Agents that share an Access identity instead tell " +
		"themselves apart with `register`: it returns your agent key once; send it (header " +
		"X-GitHive-Agent-Key, or agent_key) with every call, and what you write is attributed to you. A " +
		"registered name is never used without its key.",
	"`audit` replays the records and lists every broken convention, with the commit and the agent.",
].join("\n");

const str = { type: "string" } as const;

const TOOL_LIST = [
	{
		name: "settings",
		description:
			"Set up GitHive on a repo, or change how it's set up; whatever you leave out stays as it is. A " +
			"repo's first settings start GitHive on it (with none given, the defaults: no reviews, so a " +
			"change merges once it's pushed, and no checks), and reply with the instructions agents " +
			"follow. The review policy: required approvals, vetoes, escalate (stricter rules for chosen " +
			"paths), grants (who may vote as each role that can block a merge: registered agent names, " +
			"'person:*', a verified identity like 'person:<who>' or 'service:<id>', a pool " +
			"'service:<id>/*' (every agent registered under it, never on its own team's changes), a team " +
			"'@<org>/<team>', 'githive' for GitHive's reviewers; unlisted roles: people and GitHive's " +
			"reviewers). verify: the checks run before each merge ([] for none). Each check is a shell " +
			"command, run with bash at the repo's top on the merged code (exit 0 passes, the first failure " +
			"stops the run) in a Linux container with Node 24, npm and git, plus Python, Go or Rust when " +
			"the repo uses them; dependencies are installed first; up to 10 minutes per command; no " +
			"secrets or environment variables, so a test needing a database or an API key fails. Each " +
			"merge is held to the settings in force when it merged: the audit replays them from the " +
			"records. Returns the settings now. branch_rules sets other branches' settings by pattern " +
			"(feature/*, release/*, a name), the first match winning: each changes only the policy fields " +
			"and checks it names (verify [] for none; left out, the repo's); [] clears them. The project's " +
			"branch always has the repo's settings. skip_checks lists what the checks skip: a change " +
			"touching only these merges without them (*.md, docs/, licenses and images by default; a file " +
			"under test/, fixtures/ or examples/ always runs them); [] makes them always run. github " +
			"connects a GitHub repo ('owner/name', '' for none) through GitHive's GitHub app, installed " +
			"there: main is pushed back to it after every landing, and verify ['github-actions'] runs the " +
			"checks on its Actions instead of in containers (a workflow that runs on pushes to " +
			"githive/checks/**). Only when GitHive starts on a repo: how claims are kept. They start in " +
			"one record and shard per path, 2 segments deep over 16 records repos, once the load calls for " +
			"it (8 agents holding claims, or over 15 claim writes a minute); shard_depth shards now, this " +
			"deep (0: never), and records_repos is how many repos the shards are spread over, since a repo " +
			"takes one push at a time.",
		inputSchema: {
			type: "object",
			properties: {
				repo: str,
				github: str,
				shard_depth: { type: "number" },
				records_repos: { type: "number" },
				required: { type: "number" },
				vetoes: { type: "array", items: str },
				escalate: {
					type: "array",
					items: {
						type: "object",
						properties: {
							paths: { type: "array", items: str },
							required: { type: "number" },
							vetoes: { type: "array", items: str },
						},
						required: ["paths"],
					},
				},
				grants: { type: "object", additionalProperties: { type: "array", items: str } },
				verify: { type: "array", items: str },
				skip_checks: { type: "array", items: str },
				branch_rules: {
					type: "array",
					items: {
						type: "object",
						properties: {
							pattern: str,
							required: { type: "number" },
							vetoes: { type: "array", items: str },
							grants: { type: "object", additionalProperties: { type: "array", items: str } },
							verify: { type: "array", items: str },
						},
						required: ["pattern"],
					},
				},
			},
			required: ["repo"],
		},
	},
	{
		name: "credentials",
		description:
			"Git access. With your own change: a write token for your fork, where its branch " +
			"changes/<change> lives. With another agent's change, to review it: a read-only token for the " +
			"author's fork, the change's branch and its pushed head, and read access to the project to " +
			"diff against; it marks you as reviewing that commit in `role` (review unless you name one " +
			"that can block), so others looking at reviews see it taken, until you vote or for 15 minutes. " +
			"It refuses when as many others already review that commit as it needs: take another review. " +
			"Without a change: read access to the project repo. With a change, `git` holds the commands to " +
			"run as given: setup and push for your own, setup and diff for a review.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, role: str, agent: str },
			required: ["repo"],
		},
	},
	{
		name: "claims",
		description: "The claims in force: who holds which paths, and why.",
		inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] },
	},
	{
		name: "claim",
		description:
			"Claim paths for your change (again to extend it, or to keep it active). Into the project's " +
			"branch, or `into` another (made from `from` if it doesn't exist yet; claims are per branch). " +
			"`source` merges that whole branch into it instead (the paths are what the branch changed, and " +
			"its tip is the change). `after` names changes it depends on: it merges only once they have " +
			"merged into the same branch. Refused, naming the holder, if another claim on that branch " +
			"overlaps; a claim in the way that its agent has abandoned (see release) is released as stale " +
			"instead.",
		inputSchema: {
			type: "object",
			properties: {
				repo: str,
				change: str,
				agent: str,
				paths: { type: "array", items: str },
				intent: str,
				into: str,
				from: str,
				after: { type: "array", items: str },
				source: str,
			},
			required: ["repo", "change", "agent", "intent"],
		},
	},
	{
		name: "release",
		description:
			"Release a claim: yours, or with stale: true another agent's it has abandoned: its change " +
			"waits on that agent, unanswered for 30 minutes with nothing pushed, or 2 hours after changes " +
			"were asked for, failed checks, or approval without a merge. Never one waiting for review, " +
			"being checked to land, or on a person.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, agent: str, reason: str, stale: { type: "boolean" } },
			required: ["repo", "change", "agent"],
		},
	},
	{
		name: "add_work",
		description:
			"Add a piece of work to the repo's backlog, for agents to take (see backlog): a title, what it " +
			"should do (intent), and the paths it's likely to touch. Its id (from the title unless given) " +
			"is the change name to claim it under; `after` names pieces it depends on, and next hands it " +
			"out only once they've merged. Or `items`: many pieces at once (each with these fields), in " +
			"one write; ids in the backlog already are left as they are.",
		inputSchema: {
			type: "object",
			properties: {
				repo: str,
				title: str,
				intent: str,
				paths: { type: "array", items: str },
				after: { type: "array", items: str },
				id: str,
				items: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: str,
							intent: str,
							paths: { type: "array", items: str },
							after: { type: "array", items: str },
							id: str,
						},
						required: ["title", "intent"],
					},
				},
				agent: str,
			},
			required: ["repo", "agent"],
		},
	},
	{
		name: "reviews",
		description:
			"The reviews you may give now: changes pushed, not yours, not voted on by you and not sent " +
			"back, still needing approvals you can give (a role that can block, if you hold one it awaits; " +
			"else ordinary ones), with how many more each needs and who's reviewing it already. Reviews " +
			"you started first, then roles that can block, fewest approvals, oldest; equals in an order of " +
			"your own, so agents looking at once don't all take the same. Pick one, get it with " +
			"credentials (its change), vote.",
		inputSchema: { type: "object", properties: { repo: str, agent: str }, required: ["repo", "agent"] },
	},
	{
		name: "backlog",
		description:
			"The repo's backlog as you may take it: pieces free to build now (nobody has claimed them, nor " +
			"their paths, and what they depend on has merged; equally good, in an order of your own), and " +
			"why the others wait. Build one by claiming it with its id as the change.",
		inputSchema: { type: "object", properties: { repo: str, agent: str }, required: ["repo", "agent"] },
	},
	{
		name: "vote",
		description: "Record your review verdict on the exact commit you reviewed.",
		inputSchema: {
			type: "object",
			properties: {
				repo: str,
				commit: str,
				reviewer: str,
				role: str,
				verdict: { type: "string", enum: ["approve", "reject"] },
				evidence: str,
			},
			required: ["repo", "commit", "reviewer", "role", "verdict", "evidence"],
		},
	},
	{
		name: "merge",
		description:
			"Merge changes/<change> into the project's branch if the conventions hold, recording what was " +
			"checked, then release the claim.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, agent: str },
			required: ["repo", "change", "agent"],
		},
	},
	{
		name: "build",
		description:
			"Have GitHive's hosted builder make a change: it claims the paths, builds on changes/<change>, " +
			"asks the hosted reviewers when done, and the change merges once approved and checked.",
		inputSchema: {
			type: "object",
			properties: { repo: str, intent: str, paths: { type: "array", items: str } },
			required: ["repo", "intent", "paths"],
		},
	},
	{
		name: "request_review",
		description:
			"Ask GitHive's hosted reviewer agents to review your change's current commit (by default a " +
			"general review, and every role that can veto it); each votes with vote.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, roles: { type: "array", items: str }, summary: str },
			required: ["repo", "change"],
		},
	},
	{
		name: "audit",
		description:
			"Replay the records and list every broken convention, with the commit and the agent (and " +
			"whether a revert has resolved it).",
		inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] },
	},
	{
		name: "revert",
		description:
			"Revert a commit the audit reports: its files go back to how they were before it, in a commit " +
			"naming what it reverts.",
		inputSchema: {
			type: "object",
			properties: { repo: str, commit: str, agent: str },
			required: ["repo", "commit", "agent"],
		},
	},
	{
		name: "status",
		description:
			"Where a change stands: its claim (or how it ended; landed: it's in, though its claim isn't " +
			"released yet, so don't merge it again), its branch head, the votes on that head with their " +
			"evidence, the approvals still needed, what GitHive's hosted agents on it are doing, and (once " +
			"something's pushed) merge: whether it merges cleanly into the branch it lands on, which files " +
			"conflict and who last changed them, and any files outside your claim. Call it after each push.",
		inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] },
	},
	{
		name: "ask_human",
		description:
			"Ask a person to decide something about a change you can't settle among agents (reviewers " +
			"disagree, a trade-off needs an owner). It waits in their inbox until a person votes on the " +
			"change's commit.",
		inputSchema: {
			type: "object",
			properties: { repo: str, change: str, agent: str, reason: str },
			required: ["repo", "change", "agent", "reason"],
		},
	},
	{
		name: "register",
		description:
			"Register your agent name and get its secret key (shown once), so what you write is attributed " +
			"to you even if you share an Access identity. With your current key, rotates it. Or `agents`: " +
			"several new names at once (none registered yet), in one write, each with its own key.",
		inputSchema: {
			type: "object",
			properties: { repo: str, agent: str, agents: { type: "array", items: str } },
			required: ["repo"],
		},
	},
];

// Every tool takes the caller's agent key, for clients that can't set the header.
export const TOOLS = annotate(
	TOOL_LIST.map((tool) => ({
		...tool,
		inputSchema: {
			...tool.inputSchema,
			properties: {
				...tool.inputSchema.properties,
				agent_key: {
					type: "string",
					description: "Your agent key from register, if you can't send the X-GitHive-Agent-Key header",
				},
			},
		},
	})),
	{
		settings: writes("Set up a repo's review policy and checks", { idempotent: true }),
		credentials: writes("Get Git access", { idempotent: true }),
		claims: reads("List claims"),
		reviews: reads("List reviews you may give"),
		backlog: reads("List the backlog"),
		add_work: writes("Add work to the backlog"),
		claim: writes("Claim paths", { idempotent: true }),
		release: destroys("Release a claim", { idempotent: true }),
		vote: writes("Vote on a commit", { idempotent: true }),
		merge: writes("Merge a change"),
		build: writes("Build a change with GitHive's agent"),
		request_review: writes("Request review"),
		audit: reads("Audit the records"),
		revert: destroys("Revert a commit"),
		status: reads("Change status"),
		register: destroys("Register an agent key"),
		ask_human: writes("Ask a person"),
	},
);
