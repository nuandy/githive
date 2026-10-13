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
import {
	COMMAND_TIMEOUT_S,
	ContainerUnresponsive,
	WORKDIR,
	bootContainer,
	clip,
	gitWithToken,
	installToolchains,
	run,
} from "./container";
import { staysInRepo } from "./paths";

export { WORKDIR, clip };

// Base class for hosted agents (builders and reviewers), each working in its own container
// on a clone of one change. The loop runs from alarms in RUN_BUDGET_MS slices and keeps the
// conversation on OpenAI's side, so long runs survive across alarms.

export const RUN_BUDGET_MS = 8 * 60_000; // per alarm, well under the alarm wall-clock limit
const MAX_TURNS = 80;
const MAX_NUDGES = 3;
const MAX_LINES = 400;
const LOG_LIMIT = 200;
/** Storage keys for the running turn and for messages waiting for the next turn. */
export const TURN_IN_FLIGHT = "sandbox-turn-in-flight";
export const TURN_STARTED = "sandbox-turn-started-at";
export const INBOX = "inbox";

export const ENVIRONMENT =
	`The repository is checked out at ${WORKDIR} in a Linux container with Node.js 24, npm and git, plus ` +
	"whichever of these the repository uses: Python 3 with uv (a virtualenv at /opt/venv is active: python, " +
	"pip and uv pip install into it; uv sync installs the project), Go (go mod download), and Rust with cargo, " +
	"clippy and rustfmt (cargo fetch). Dependencies may already be installed from the project's main branch; " +
	"install them again if the change touches what they come from (package.json, a lockfile, pyproject.toml, " +
	`go.mod, Cargo.toml...). Commands time out after ${COMMAND_TIMEOUT_S} seconds.`;

export interface SandboxJob {
	/** The agent's own name, such as <project>--<change>. It keys the prompt cache. */
	repo: string;
	remote: string;
	token: string;
}

/** A job about one change, shared by builders and reviewers. */
export interface ChangeJob extends SandboxJob {
	/** The project repo the change merges into. */
	project: string;
	branch: string;
	verify: string[];
	change: string;
	/** The change's branch in its author's fork. */
	ref: string;
	agent: string;
	intent: string;
	/** The only paths the change may touch. */
	claim: string[];
	others: { change: string; claim: string[] }[];
}

/** The change's context, worded the same way for every agent. */
export function changeContext(job: ChangeJob) {
	const checks = job.verify.length ? job.verify.join("; ") : "no checks configured; run the project's own tests";
	return [
		`Change: ${job.change}. What it should do: ${job.intent}`,
		`Its claim (the only paths this change may touch): ${job.claim.join(", ")}`,
		`Before it merges, the project's checks must pass with it merged into ${job.branch}: ${checks}`,
		"Other changes in progress at the same time:",
		job.others.map((other) => `- ${other.change} (claims ${other.claim.join(", ")})`).join("\n") || "- none",
	].join("\n");
}

export interface AgentState {
	status: "queued" | "working" | "done" | "failed";
	startedAt: string;
	finishedAt?: string;
	turns: number;
	/** `turns` when the current run started, since each revision gets its own turn budget. */
	turnsAtRunStart?: number;
	toolCalls: number;
	nudges: number;
	usage: Usage;
	error?: string;
	log: { at: string; event: string }[];
	previousResponseId?: string;
	pending?: ResponseInputItem[];
}

/** Where an agent's conversation with the model stands: its last response, and what that response is owed. */
export interface Conversation {
	responseId: string;
	pending: ResponseInputItem[];
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

/** OpenAI's prompt_cache_key for an agent, shortened with a hash suffix past 64 characters. */
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
	protected lifecycle<T>(work: () => Promise<T>): Promise<T> {
		const next = this.lifecycleTail.then(work, work);
		this.lifecycleTail = next.catch(() => {});
		return next;
	}

	protected abstract readonly kind: string;
	protected abstract instructions(job: J): string;
	protected abstract tools(job: J, state: S): AgentTool[];
	protected abstract kickoff(job: J): string;
	/** Sent when the model answers in text instead of finishing. */
	protected abstract nudge(job: J): string;
	protected abstract freshFields(): Omit<S, keyof AgentState>;
	protected abstract afterClone(job: J, state: S): Promise<void>;
	/** Why a run_command must not run, if it must not. */
	protected commandRefusal(_command: string, _state: S): string | undefined {
		return undefined;
	}
	protected staleKeys(): string[] {
		return ["cancel", INBOX, TURN_IN_FLIGHT, TURN_STARTED];
	}
	/** Runs once when the agent fails, for example to give its claim back. */
	protected async onFailed(_job: J, _state: S): Promise<void> {}
	/** What GitHive has to tell the model before its next turn, such as news about its change. */
	protected async heard(_job: J, _state: S): Promise<string[]> {
		return [];
	}

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
			...this.continuing(job),
		} as unknown as S; // base fields + the subclass's fields make a full S
		await this.ctx.storage.put("job", job);
		await this.ctx.storage.delete(this.staleKeys());
		await this.save(fresh);
		await this.ctx.storage.setAlarm(Date.now());
		return this.view(fresh);
	}

	/**
	 * Ask a queued or working agent to stop. The loop holds its state in memory, so it
	 * checks this flag before each turn rather than having its state overwritten.
	 */
	async cancel(reason: string) {
		const { state } = await this.load();
		if (!state || (state.status !== "queued" && state.status !== "working")) return false;
		await this.ctx.storage.put("cancel", reason);
		return true;
	}

	/**
	 * Leave a message for the agent's next turn. Returns false when the agent isn't running. One left during a turn
	 * waits for the next: a turn acknowledges only the messages it sent.
	 */
	async notify(message: string) {
		return this.lifecycle(async () => {
			const { state } = await this.load();
			if (!state || (state.status !== "queued" && state.status !== "working")) return false;
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
		for (const text of sent) {
			const firstLine = text.split("\n")[0] ?? "";
			this.note(state, "message delivered: " + firstLine.slice(0, 160));
		}
	}

	private async cancelled(state: S) {
		const reason = await this.ctx.storage.get<string>("cancel");
		if (!reason) return false;
		state.status = "failed";
		state.error = `cancelled: ${reason}`;
		this.note(state, state.error);
		return true;
	}

	/** The state without the conversation plumbing. */
	protected view(state: S) {
		const { previousResponseId: _id, pending: _pending, ...rest } = state;
		return rest;
	}

	async state() {
		const { state } = await this.load();
		return state ? this.view(state) : null;
	}

	/** Where its conversation with the model stands, for another agent to continue it, or null if it never began. */
	async conversation(): Promise<Conversation | null> {
		const { state } = await this.load();
		if (!state?.previousResponseId) return null;
		return { responseId: state.previousResponseId, pending: state.pending ?? [] };
	}

	/** A conversation to continue instead of starting a new one with the kickoff; none by default. */
	protected continuing(_job: J): Pick<AgentState, "previousResponseId" | "pending"> {
		return {};
	}

	async alarm() {
		const { job, state } = await this.load();
		if (!job || !state) return;
		if (state.status !== "queued" && state.status !== "working") return;
		if (state.status === "working" && (await this.waitingForEarlierTurn())) return;
		try {
			await this.runSlice(job, state);
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

	/**
	 * Whether a turn may still be running in an earlier alarm. The agent waits for it, with a later alarm, unless it is
	 * long overdue.
	 */
	private async waitingForEarlierTurn() {
		if (!(await this.ctx.storage.get(TURN_IN_FLIGHT))) return false;
		const started = await this.ctx.storage.get<number>(TURN_STARTED);
		if (started && Date.now() - started < RUN_BUDGET_MS + 30_000) {
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
			return true;
		}
		await this.ctx.storage.delete([TURN_IN_FLIGHT, TURN_STARTED]);
		return false;
	}

	/** Sets up the container if needed and runs turns for one alarm's budget, scheduling the next slice. */
	private async runSlice(job: J, state: S) {
		if (await this.cancelled(state)) throw new Error(state.error);
		if (state.status === "queued" || !this.ctx.container?.running) {
			await this.setUp(job, state);
			state.status = "working";
			await this.save(state);
		}
		await this.ctx.container!.setInactivityTimeout(20 * 60_000);
		const deadline = Date.now() + RUN_BUDGET_MS;
		while (state.status === "working" && Date.now() < deadline && !(await this.cancelled(state))) {
			// One that stopped answering was destroyed mid-turn (see replaceIfHung): a fresh one before the next turn.
			if (!this.ctx.container?.running) await this.setUp(job, state);
			await this.runTurn(job, state);
		}
		if (state.status === "working") await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	/** Runs one turn, marked in flight so messages wait for it, then picks up any fresh credentials. */
	private async runTurn(job: J, state: S) {
		const turnToken = crypto.randomUUID();
		await this.lifecycle(async () => this.ctx.storage.put({ [TURN_IN_FLIGHT]: turnToken, [TURN_STARTED]: Date.now() }));
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

	/** Runs after a turn is saved, to apply anything that arrived during it. */
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
		const project = (job as Partial<ChangeJob>).project;
		const snapshot = project
			? await rpc(this.env.GATE.getByName(`repo:${project}`).snapshot()).catch(() => null)
			: null;
		const booted = await bootContainer(container, "standard-1", snapshot);
		if (booted === "restored") {
			await this.pointSnapshotAt(container, job);
			this.note(state, "started from the project's snapshot");
		} else {
			// A container that outlived its object, for example across a deploy, still has the last checkout.
			await run(container, ["rm", "-rf", WORKDIR], "/");
			const clone = await this.git(job, ["clone", "--quiet", job.remote, WORKDIR], "/");
			if (clone.exitCode !== 0) throw new Error(`clone failed: ${clip(clone.output, 2_000)}`);
			this.note(state, "repository cloned");
		}
		await this.afterClone(job, state);
		// A failed install is only noted. The agent will find the missing tool for itself.
		for (const installed of await installToolchains(container)) {
			if (installed.exitCode === 0) this.note(state, `installed ${installed.toolchain}`);
			else this.note(state, `installing ${installed.toolchain} failed: ${clip(installed.output, 300)}`);
		}
		if (restart)
			state.pending = [
				...(state.pending ?? []),
				{
					role: "user",
					content: "The container restarted. Uncommitted changes were lost; the repository was cloned again.",
				},
			];
	}

	/** Points the snapshot's checkout at this job's remote. afterClone fetches what the job needs. */
	private async pointSnapshotAt(container: Container, job: J) {
		const reset = await run(container, ["bash", "-c", "git checkout -q -f --detach && git clean -fdq"]);
		const pointed = await run(container, ["git", "remote", "set-url", "origin", job.remote]);
		if (reset.exitCode !== 0 || pointed.exitCode !== 0)
			throw new Error(`setting up the snapshot's checkout failed: ${clip(reset.output + pointed.output, 2_000)}`);
	}

	protected exec(cmd: string[], cwd = WORKDIR, stdin?: string) {
		return this.replaceIfHung(run(this.ctx.container!, cmd, cwd, stdin));
	}

	protected async git(job: J, args: string[], cwd = WORKDIR, token = job.token) {
		return this.replaceIfHung(gitWithToken(this.ctx.container!, token, args, cwd));
	}

	/**
	 * A command's result. If the container stopped answering, it's destroyed, so the next turn starts with a fresh one
	 * instead of waiting out the command's limit; the agent hears the command failed, then that the container restarted.
	 */
	private async replaceIfHung<T>(command: Promise<T>) {
		try {
			return await command;
		} catch (err) {
			if (err instanceof ContainerUnresponsive) await this.ctx.container?.destroy(err.message).catch(() => undefined);
			throw err;
		}
	}

	protected baseTools(state: S): AgentTool[] {
		return [
			tool({
				name: "list_files",
				description: "List files in the repository (tracked and new, ignoring .gitignore'd paths).",
				schema: ListArgs,
				run: async ({ prefix }) => {
					const listed = await this.exec(["git", "ls-files", "--cached", "--others", "--exclude-standard"]);
					const files = listed.output.split("\n").filter((file) => file && file.startsWith(prefix));
					const shown = files.slice(0, 500).join("\n");
					const more = files.length > 500 ? `\n(${files.length - 500} more)` : "";
					return shown + more || "No files.";
				},
			}),
			tool({
				name: "read_file",
				description: `Read a text file, ${MAX_LINES} numbered lines at a time.`,
				schema: ReadArgs,
				run: async ({ path, start_line }) => {
					const read = await this.exec(["cat", "--", repoPath(path)]);
					if (read.exitCode !== 0) return read.output;
					const lines = read.output.split("\n");
					const from = Math.max(1, Math.trunc(start_line));
					const to = Math.min(lines.length, from + MAX_LINES - 1);
					const body = lines
						.slice(from - 1, to)
						.map((line, index) => `${from + index}\t${line}`)
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
					const written = await this.exec(
						["bash", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "write", target],
						WORKDIR,
						content,
					);
					return written.exitCode === 0 ? `Wrote ${target}.` : written.output;
				},
			}),
			tool({
				name: "run_command",
				description:
					`Run a bash command in ${WORKDIR}. Use it for npm install, tests, type checks, git and ` + "inspection.",
				schema: RunArgs,
				run: async ({ command }) => {
					const reason = this.commandRefusal(command, state);
					if (reason) {
						this.note(state, `blocked unsafe git command: ${command.slice(0, 160)}`);
						return `Command refused: ${reason}`;
					}
					this.note(state, `run: ${command.slice(0, 200)}`);
					const ran = await this.exec(["bash", "-lc", command]);
					return `exit code ${ran.exitCode}\n${clip(ran.output)}`;
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
		// Advice: a turn goes on without it.
		const heard = await this.heard(job, state).catch(() => []);
		// The first turn opens with the kickoff. Later turns send what the previous one left pending.
		const opening: ResponseInputItem[] = state.previousResponseId
			? (state.pending ?? [])
			: [{ role: "user", content: this.kickoff(job) }];
		const told = [...inbox, ...heard].map((content) => ({ role: "user" as const, content }));
		const ask = (opening: ResponseInputItem[], previous?: string) =>
			client.responses.create({
				model: MODEL,
				instructions: this.instructions(job),
				input: [...opening, ...told],
				previous_response_id: previous,
				tools: openAITools(tools),
				reasoning: { effort: "high" },
				max_output_tokens: 32000,
				prompt_cache_key: promptCacheKey(this.kind, job.repo),
			});
		const handedOn = state.turns === 0 && !!state.previousResponseId;
		const response = await ask(opening, state.previousResponseId).catch((err) => {
			if (!handedOn) throw err;
			// The conversation it was given can't be continued (it may have expired): start afresh.
			this.note(state, `couldn't continue the earlier conversation, starting afresh: ${String(err).slice(0, 160)}`);
			return ask([{ role: "user", content: this.kickoff(job) }]);
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
