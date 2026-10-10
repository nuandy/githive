import { DurableObject } from "cloudflare:workers";
import { rpc } from "./rpc";
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import {
	MODEL,
	addUsage,
	assertComplete,
	emptyUsage,
	openAITools,
	runCalls,
	tool,
	type AgentTool,
	type Usage,
} from "./agent";
import { COMMAND_TIMEOUT_S, WORKDIR, bootContainer, clip, gitWithToken, installToolchains, run } from "./container";
import { staysInRepo } from "./paths";

export { WORKDIR, clip };

// Base for GitHive's hosted agents, which work in their own Linux container
// on a clone of one change: builders and reviewers. It owns the container
// lifecycle, the alarm-driven agent loop, and the tools every such agent
// needs. What only builders do (guarding pushes) is in builder.ts, behind the
// hooks below.
//
// The loop runs from alarms in RUN_BUDGET_MS slices and keeps the conversation
// on OpenAI's side (previous_response_id), so long runs survive across alarm
// invocations. Git credentials never enter the container's files or
// environment: the token is passed only on the git commands run here.

export const RUN_BUDGET_MS = 8 * 60_000; // per alarm, well under the alarm wall-clock limit
const MAX_TURNS = 80;
const MAX_NUDGES = 3;
const MAX_LINES = 400;
const LOG_LIMIT = 200;
/** Storage keys: the turn running now (its token, and when it started), and messages waiting for the next turn. */
export const TURN_IN_FLIGHT = "sandbox-turn-in-flight";
export const TURN_STARTED = "sandbox-turn-started-at";
export const INBOX = "inbox";

/** Facts every agent prompt should state about the environment. */
export const ENVIRONMENT = `The repository is checked out at ${WORKDIR} in a Linux container with Node.js 24, npm and git, plus whichever of these the repository uses: Python 3 with uv (a virtualenv at /opt/venv is active: python, pip and uv pip install into it; uv sync installs the project), Go (go mod download), and Rust with cargo, clippy and rustfmt (cargo fetch). Dependencies may already be installed from the project's main branch; install them again if the change touches what they come from (package.json, a lockfile, pyproject.toml, go.mod, Cargo.toml...). Commands time out after ${COMMAND_TIMEOUT_S} seconds.`;

export interface SandboxJob {
	/** The agent's own name, for prompt caching: <project>--<change>, say. */
	repo: string;
	remote: string;
	token: string;
}

/** A job about one change: what builders and reviewers share. */
export interface ChangeJob extends SandboxJob {
	/** The project repo the change merges into, its branch (main, master, ...) and its checks. */
	project: string;
	branch: string;
	verify: string[];
	change: string;
	/** The change's own branch in its author's fork: changes/<change>. */
	ref: string;
	/** Its claim's agent, as the records name it. */
	agent: string;
	intent: string;
	/** Its claim: the only paths it may change. */
	claim: string[];
	/** The other claims in force. */
	others: { change: string; claim: string[] }[];
}

/** The change's place in the repo, stated the same way to every agent. */
export function changeContext(job: ChangeJob) {
	return `Change: ${job.change}. What it should do: ${job.intent}
Its claim (the only paths this change may touch): ${job.claim.join(", ")}
Before it merges, the project's checks must pass with it merged into ${job.branch}: ${job.verify.length ? job.verify.join("; ") : "no checks configured; run the project's own tests"}
Other changes in progress at the same time:
${job.others.map((o) => `- ${o.change} (claims ${o.claim.join(", ")})`).join("\n") || "- none"}`;
}

export interface AgentState {
	status: "queued" | "working" | "done" | "failed";
	startedAt: string;
	finishedAt?: string;
	turns: number;
	/** `turns` when the current run started; each run (a revision) gets its own budget. */
	turnsAtRunStart?: number;
	toolCalls: number;
	nudges: number;
	usage: Usage;
	error?: string;
	/** Most recent events, newest last. */
	log: { at: string; event: string }[];
	previousResponseId?: string;
	pending?: ResponseInputItem[];
}

const ReadArgs = z.strictObject({
	path: z.string().describe("Path relative to the repository root"),
	start_line: z.number().describe("First line to return, counting from 1"),
});
const WriteArgs = z.strictObject({
	path: z.string().describe("Path relative to the repository root"),
	content: z.string().describe("The complete new file content"),
});
const ListArgs = z.strictObject({ prefix: z.string().describe('Only list paths starting with this; "" for all') });
const RunArgs = z.strictObject({
	command: z.string().describe(`A bash command, run in ${WORKDIR} with a ${COMMAND_TIMEOUT_S}s limit`),
});

const MAX_CACHE_KEY = 64;

/** OpenAI's prompt_cache_key for an agent: `<kind>-<repo>`, cut to 64 characters with a hash of the whole when longer. */
export function promptCacheKey(kind: string, repo: string) {
	const key = `${kind}-${repo}`;
	if (key.length <= MAX_CACHE_KEY) return key;
	// FNV-1a: stable across restarts, so an agent keeps its cache.
	let hash = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
	const suffix = `-${(hash >>> 0).toString(16).padStart(8, "0")}`;
	return key.slice(0, MAX_CACHE_KEY - suffix.length) + suffix;
}

export function repoPath(path: string) {
	const clean = path.replace(/^\.\//, "");
	if (!clean || !staysInRepo(clean)) throw new Error(`path must stay inside the repository: ${path}`);
	return clean;
}

export abstract class SandboxAgent<J extends SandboxJob, S extends AgentState> extends DurableObject<Env> {
	private lifecycleTail: Promise<unknown> = Promise.resolve();

	/** Run storage changes that race with the agent loop (messages) one at a time. */
	protected lifecycle<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.lifecycleTail.then(fn, fn);
		this.lifecycleTail = next.catch(() => {});
		return next;
	}

	/** Short name for logs and prompt-cache keys, e.g. "builder". */
	protected abstract readonly kind: string;
	protected abstract instructions(job: J): string;
	protected abstract tools(job: J, state: S): AgentTool[];
	/** First user message of the conversation. */
	protected abstract kickoff(job: J): string;
	/** Sent when the model answers in text instead of finishing. */
	protected abstract nudge(job: J): string;
	/** Fields a subclass adds to a fresh state. */
	protected abstract freshFields(): Omit<S, keyof AgentState>;
	/** Runs after each clone, in WORKDIR. */
	protected abstract afterClone(job: J, state: S): Promise<void>;
	/** Why a run_command must not run, if it must not. */
	protected commandRefusal(_command: string, _state: S): string | undefined {
		return undefined;
	}
	/** Storage keys a fresh start clears. */
	protected staleKeys(): string[] {
		return ["cancel", INBOX, TURN_IN_FLIGHT, TURN_STARTED];
	}
	/** Runs once when the agent fails; for example, to give its claim back. */
	protected async onFailed(_job: J, _state: S): Promise<void> {}

	protected async load() {
		const [job, state] = await Promise.all([this.ctx.storage.get<J>("job"), this.ctx.storage.get<S>("state")]);
		return { job, state };
	}

	protected save(state: S) {
		state.log = state.log.slice(-LOG_LIMIT);
		return this.ctx.storage.put("state", state);
	}

	protected note(state: S, event: string) {
		state.log.push({ at: new Date().toISOString(), event });
	}

	async start(job: J) {
		const { state } = await this.load();
		if (state && (state.status === "queued" || state.status === "working"))
			throw new Error(`${this.kind} is already ${state.status}`);
		const fresh = {
			status: "queued",
			startedAt: new Date().toISOString(),
			turns: 0,
			toolCalls: 0,
			nudges: 0,
			usage: emptyUsage(),
			log: [],
			...this.freshFields(),
		} as unknown as S; // base fields + the subclass's fields make a full S
		await this.ctx.storage.put("job", job);
		await this.ctx.storage.delete(this.staleKeys());
		await this.save(fresh);
		await this.ctx.storage.setAlarm(Date.now());
		return this.view(fresh);
	}

	/**
	 * Ask a queued or working agent to stop. Cooperative: the agent loop holds its
	 * state in memory, so it checks this flag before each turn rather than having
	 * its state overwritten underneath it.
	 */
	async cancel(reason: string) {
		const { state } = await this.load();
		if (!state || (state.status !== "queued" && state.status !== "working")) return false;
		await this.ctx.storage.put("cancel", reason);
		return true;
	}

	/**
	 * Leave a message for a running agent; it reads it at its next turn. Returns
	 * false when the agent isn't running, so the caller can handle that case.
	 */
	async notify(message: string) {
		return this.lifecycle(async () => {
			const { state } = await this.load();
			if (!state || (state.status !== "queued" && state.status !== "working")) return false;
			if (state.status === "working" && (await this.ctx.storage.get(TURN_IN_FLIGHT))) return false;
			const inbox = (await this.ctx.storage.get<string[]>(INBOX)) ?? [];
			await this.ctx.storage.put(INBOX, [...inbox, message]);
			return true;
		});
	}

	private async peekInbox() {
		return (await this.ctx.storage.get<string[]>(INBOX)) ?? [];
	}

	private async acknowledgeInbox(sent: string[], state: S) {
		if (!sent.length) return;
		const inbox = (await this.ctx.storage.get<string[]>(INBOX)) ?? [];
		if (sent.every((message, index) => inbox[index] === message))
			await this.ctx.storage.put(INBOX, inbox.slice(sent.length));
		for (const text of sent) this.note(state, "message delivered: " + text.split("\n")[0].slice(0, 160));
	}

	private async cancelled(state: S) {
		const reason = await this.ctx.storage.get<string>("cancel");
		if (!reason) return false;
		state.status = "failed";
		state.error = `cancelled: ${reason}`;
		this.note(state, state.error);
		return true;
	}

	/** Public view: everything except the conversation plumbing. */
	protected view(state: S) {
		const { previousResponseId: _id, pending: _pending, ...rest } = state;
		return rest;
	}

	async state() {
		const { state } = await this.load();
		return state ? this.view(state) : null;
	}

	async alarm() {
		const { job, state } = await this.load();
		if (!job || !state) return;
		if (state.status !== "queued" && state.status !== "working") return;
		if (state.status === "working" && (await this.ctx.storage.get(TURN_IN_FLIGHT))) {
			// A turn may still be running in an earlier alarm; wait for it unless it is long overdue.
			const started = await this.ctx.storage.get<number>(TURN_STARTED);
			if (started && Date.now() - started < RUN_BUDGET_MS + 30_000) {
				await this.ctx.storage.setAlarm(Date.now() + 60_000);
				return;
			}
			await this.ctx.storage.delete([TURN_IN_FLIGHT, TURN_STARTED]);
		}
		try {
			if (await this.cancelled(state)) throw new Error(state.error);
			if (state.status === "queued" || !this.ctx.container?.running) {
				await this.setUp(job, state);
				state.status = "working";
				await this.save(state);
			}
			await this.ctx.container!.setInactivityTimeout(20 * 60_000);
			const deadline = Date.now() + RUN_BUDGET_MS;
			while (state.status === "working" && Date.now() < deadline && !(await this.cancelled(state))) {
				const turnToken = crypto.randomUUID();
				await this.lifecycle(async () =>
					this.ctx.storage.put({ [TURN_IN_FLIGHT]: turnToken, [TURN_STARTED]: Date.now() }),
				);
				try {
					await this.turn(job, state);
					await this.save(state);
					await this.afterTurn(job, state, turnToken);
				} finally {
					await this.endTurn(turnToken);
				}
				// A revision may have brought fresh credentials.
				const refreshed = await this.ctx.storage.get<J>("job");
				if (refreshed) Object.assign(job, refreshed);
			}
			if (state.status === "working") await this.ctx.storage.setAlarm(Date.now() + 1_000);
		} catch (err) {
			state.status = "failed";
			state.error ??= err instanceof Error ? err.message : String(err);
			if (!state.error.startsWith("cancelled")) this.note(state, `failed: ${state.error}`);
		}
		// Tools change the status inside closures, which TypeScript can't see.
		if (["done", "failed"].includes(state.status)) {
			state.finishedAt = new Date().toISOString();
			if (this.ctx.container?.running) await this.ctx.container.destroy(`${this.kind} ${state.status}`);
		}
		await this.save(state);
		if ((state.status as string) === "failed") await this.onFailed(job, state).catch(() => {});
	}

	/** Once a turn is saved: apply what arrived during it. */
	protected async afterTurn(_job: J, state: S, turnToken: string) {
		await this.lifecycle(async () => {
			await this.save(state);
			await this.endTurn(turnToken);
		});
	}

	/** Mark the turn finished, unless a newer one has started. */
	protected async endTurn(turnToken: string) {
		if ((await this.ctx.storage.get<string>(TURN_IN_FLIGHT)) === turnToken)
			await this.ctx.storage.delete([TURN_IN_FLIGHT, TURN_STARTED]);
	}

	private async setUp(job: J, state: S) {
		const container = this.ctx.container;
		if (!container) throw new Error(`no container is configured for ${this.kind}`);
		const restart = state.status === "working";
		this.note(state, restart ? "container restarted; re-cloning" : "starting container");
		// The project's snapshot, when it has one: its checkout with main's dependencies installed, in seconds.
		const project = (job as Partial<ChangeJob>).project;
		const snapshot = project
			? await rpc(this.env.GATE.getByName(`repo:${project}`).snapshot()).catch(() => null)
			: null;
		const booted = await bootContainer(container, "standard-1", snapshot);
		if (booted === "restored") {
			// Its checkout, pointed at this job's remote; afterClone fetches what the job needs from it.
			const reset = await run(container, ["bash", "-c", "git checkout -q -f --detach && git clean -fdq"]);
			const pointed = await run(container, ["git", "remote", "set-url", "origin", job.remote]);
			if (reset.exitCode !== 0 || pointed.exitCode !== 0)
				throw new Error(`setting up the snapshot's checkout failed: ${clip(reset.output + pointed.output, 2_000)}`);
			this.note(state, "started from the project's snapshot");
		} else {
			// A container that outlived its object (a deploy, say) still has the last checkout.
			await run(container, ["rm", "-rf", WORKDIR], "/");
			const clone = await this.git(job, ["clone", "--quiet", job.remote, WORKDIR], "/");
			if (clone.exitCode !== 0) throw new Error(`clone failed: ${clip(clone.output, 2_000)}`);
			this.note(state, "repository cloned");
		}
		await this.afterClone(job, state);
		// Toolchains the checkout uses beyond Node; a failed install is noted, and the agent sees the missing tool for itself.
		for (const installed of await installToolchains(container))
			this.note(
				state,
				installed.exitCode === 0
					? `installed ${installed.toolchain}`
					: `installing ${installed.toolchain} failed: ${clip(installed.output, 300)}`,
			);
		if (restart)
			state.pending = [
				...(state.pending ?? []),
				{
					role: "user",
					content: "The container restarted. Uncommitted changes were lost; the repository was cloned again.",
				},
			];
	}

	protected exec(cmd: string[], cwd = WORKDIR, stdin?: string) {
		return run(this.ctx.container!, cmd, cwd, stdin);
	}

	/** Run git with a token (the job's, by default) on this one command only. */
	protected async git(job: J, args: string[], cwd = WORKDIR, token = job.token) {
		return gitWithToken(this.ctx.container!, token, args, cwd);
	}

	/** Tools every container agent gets: explore, edit and run commands. */
	protected baseTools(state: S): AgentTool[] {
		return [
			tool({
				name: "list_files",
				description: "List files in the repository (tracked and new, ignoring .gitignore'd paths).",
				schema: ListArgs,
				run: async ({ prefix }) => {
					const r = await this.exec(["git", "ls-files", "--cached", "--others", "--exclude-standard"]);
					const files = r.output.split("\n").filter((f) => f && f.startsWith(prefix));
					return (
						files.slice(0, 500).join("\n") + (files.length > 500 ? `\n(${files.length - 500} more)` : "") || "No files."
					);
				},
			}),
			tool({
				name: "read_file",
				description: `Read a text file, ${MAX_LINES} numbered lines at a time.`,
				schema: ReadArgs,
				run: async ({ path, start_line }) => {
					const r = await this.exec(["cat", "--", repoPath(path)]);
					if (r.exitCode !== 0) return r.output;
					const lines = r.output.split("\n");
					const from = Math.max(1, Math.trunc(start_line));
					const to = Math.min(lines.length, from + MAX_LINES - 1);
					const body = lines
						.slice(from - 1, to)
						.map((l, i) => `${from + i}\t${l}`)
						.join("\n");
					return to < lines.length ? `${body}\n(lines ${from}-${to} of ${lines.length})` : body;
				},
			}),
			tool({
				name: "write_file",
				description: "Create or overwrite a file with complete content.",
				schema: WriteArgs,
				run: async ({ path, content }) => {
					const target = repoPath(path);
					const r = await this.exec(
						["bash", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "write", target],
						WORKDIR,
						content,
					);
					return r.exitCode === 0 ? `Wrote ${target}.` : r.output;
				},
			}),
			tool({
				name: "run_command",
				description: `Run a bash command in ${WORKDIR}. Use it for npm install, tests, type checks, git and inspection.`,
				schema: RunArgs,
				run: async ({ command }) => {
					const reason = this.commandRefusal(command, state);
					if (reason) {
						this.note(state, `blocked unsafe git command: ${command.slice(0, 160)}`);
						return `Command refused: ${reason}`;
					}
					this.note(state, `run: ${command.slice(0, 200)}`);
					const r = await this.exec(["bash", "-lc", command]);
					return `exit code ${r.exitCode}\n${clip(r.output)}`;
				},
			}),
		];
	}

	private async turn(job: J, state: S) {
		if (state.turns - (state.turnsAtRunStart ?? 0) >= MAX_TURNS)
			throw new Error(`stopped after ${MAX_TURNS} turns without finishing`);
		const client = new OpenAI({ apiKey: this.env.OPENAI_API_KEY });
		const tools = this.tools(job, state);
		const inbox = await this.peekInbox();
		const input: ResponseInputItem[] = [
			...(state.previousResponseId ? (state.pending ?? []) : [{ role: "user" as const, content: this.kickoff(job) }]),
			...inbox.map((content) => ({ role: "user" as const, content })),
		];
		const response = await client.responses.create({
			model: MODEL,
			instructions: this.instructions(job),
			input,
			previous_response_id: state.previousResponseId,
			tools: openAITools(tools),
			reasoning: { effort: "high" },
			max_output_tokens: 32000,
			prompt_cache_key: promptCacheKey(this.kind, job.repo),
		});
		await this.acknowledgeInbox(inbox, state);
		state.turns++;
		addUsage(state.usage, response);
		assertComplete(response, this.kind);
		state.previousResponseId = response.id;

		const outputs = await runCalls(tools, response);
		state.toolCalls += outputs.length;
		if (outputs.length) {
			state.pending = outputs;
			return;
		}
		// The model answered in text without finishing.
		if (++state.nudges > MAX_NUDGES) throw new Error(`${this.kind} stopped calling tools without finishing`);
		this.note(state, `nudged: ${response.output_text.slice(0, 200)}`);
		state.pending = [{ role: "user", content: this.nudge(job) }];
	}
}
