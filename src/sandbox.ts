import { DurableObject } from "cloudflare:workers";
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import { MODEL, addUsage, assertComplete, emptyUsage, openAITools, runCalls, tool, type AgentTool, type Usage } from "./agent";
import { COMMAND_TIMEOUT_S, WORKDIR, bootContainer, clip, gitWithToken, run } from "./container";
import type { SliceSpec } from "./types";

export { WORKDIR, clip };

// Base for agents that work in their own Linux container on a clone of one
// Artifacts repo: builders and reviewers. It owns the container lifecycle, the
// alarm-driven agent loop, and the tools every such agent needs.
//
// The loop runs from alarms in RUN_BUDGET_MS slices and keeps the conversation
// on OpenAI's side (previous_response_id), so long runs survive across alarm
// invocations. Git credentials never enter the container's files or
// environment: the token is passed only on the git commands run here.

const RUN_BUDGET_MS = 8 * 60_000; // per alarm, well under the alarm wall-clock limit
const MAX_TURNS = 80;
const MAX_NUDGES = 3;
const MAX_LINES = 400;
const LOG_LIMIT = 200;

/** Facts every agent prompt should state about the environment. */
export const ENVIRONMENT = `The repository is checked out at ${WORKDIR} in a Linux container with Node.js 24, npm and git. Python is not installed; use node for scripting. Commands time out after ${COMMAND_TIMEOUT_S} seconds.`;

export interface SandboxJob {
	taskId: string;
	repo: string;
	remote: string;
	token: string;
}

/** A job about one slice of a task: what builders and reviewers share. */
export interface SliceJob extends SandboxJob {
	goal: string;
	/** Commands the integration gate runs on the combined code. */
	verify?: string[];
	slice: SliceSpec;
	siblings: Pick<SliceSpec, "id" | "title" | "owns">[];
	contracts: string[];
}

/** The slice's place in the task, stated the same way to every agent. */
export function sliceContext(job: SliceJob) {
	const tests = job.slice.tests?.length
		? `${job.slice.tests.join(", ")}. Other slices' contract tests may fail on this slice alone; they pass once everything is integrated.`
		: "not specified; run the tests the brief names.";
	return `Overall goal of the task: ${job.goal}

Slice: ${job.slice.title} (${job.slice.id})
Lane (the only paths this slice may change): ${job.slice.owns.join(", ")}
Contract files, committed before work started (they change only through approved amendments): ${job.contracts.join(", ") || "none"}
Acceptance tests for this slice: ${tests}
Before the slice is integrated, the combined code (this slice merged with everything integrated so far) must pass: ${job.verify?.length ? job.verify.join("; ") : "no extra checks"}
Other slices being built at the same time:
${job.siblings.map((s) => `- ${s.id}: ${s.title} (owns ${s.owns.join(", ")})`).join("\n") || "- none"}

The slice's brief:
${job.slice.instructions}`;
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
const RunArgs = z.strictObject({ command: z.string().describe(`A bash command, run in ${WORKDIR} with a ${COMMAND_TIMEOUT_S}s limit`) });

export function repoPath(path: string) {
	const clean = path.replace(/^\.\//, "");
	if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) throw new Error(`path must stay inside the repository: ${path}`);
	return clean;
}

export abstract class SandboxAgent<J extends SandboxJob, S extends AgentState> extends DurableObject<Env> {
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
	/** Runs once when the agent fails; for example, to flag its slice for a human. */
	protected async onFailed(_job: J, _state: S): Promise<void> {}
	/** Runs once when the agent stops for any reason (done, failed, cancelled); frees its slot in the task's limits. */
	protected async onStopped(_job: J, _state: S): Promise<void> {}

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
		if (state && (state.status === "queued" || state.status === "working")) throw new Error(`${this.kind} is already ${state.status}`);
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
		await this.ctx.storage.delete(["cancel", "inbox"]);
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
		const { state } = await this.load();
		if (!state || (state.status !== "queued" && state.status !== "working")) return false;
		const inbox = (await this.ctx.storage.get<string[]>("inbox")) ?? [];
		await this.ctx.storage.put("inbox", [...inbox, message]);
		return true;
	}

	private async drainInbox(state: S): Promise<ResponseInputItem[]> {
		const inbox = (await this.ctx.storage.get<string[]>("inbox")) ?? [];
		if (!inbox.length) return [];
		await this.ctx.storage.delete("inbox");
		for (const text of inbox) this.note(state, `message delivered: ${text.split("\n")[0].slice(0, 160)}`);
		return inbox.map((text) => ({ role: "user" as const, content: text }));
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
		if (!job || !state || (state.status !== "queued" && state.status !== "working")) return;
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
				await this.turn(job, state);
				await this.save(state);
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
		if (["done", "failed"].includes(state.status)) await this.onStopped(job, state).catch(() => {});
	}

	private async setUp(job: J, state: S) {
		const container = this.ctx.container;
		if (!container) throw new Error(`no container is configured for ${this.kind}`);
		const restart = state.status === "working";
		this.note(state, restart ? "container restarted; re-cloning" : "starting container");
		await bootContainer(container);
		const clone = await this.git(job, ["clone", "--quiet", job.remote, WORKDIR], "/");
		if (clone.exitCode !== 0) throw new Error(`clone failed: ${clip(clone.output, 2_000)}`);
		await this.afterClone(job, state);
		this.note(state, "repository cloned");
		if (restart)
			state.pending = [
				...(state.pending ?? []),
				{ role: "user", content: "The container restarted. Uncommitted changes were lost; the repository was cloned again." },
			];
	}

	protected exec(cmd: string[], cwd = WORKDIR, stdin?: string) {
		return run(this.ctx.container!, cmd, cwd, stdin);
	}

	/** Run git with a token (the job's, by default) on this one command only. */
	protected git(job: J, args: string[], cwd = WORKDIR, token = job.token) {
		return gitWithToken(this.ctx.container!, token, args, cwd);
	}

	protected coordinator(job: J) {
		return this.env.COORDINATOR.get(this.env.COORDINATOR.idFromName(job.taskId));
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
					return files.slice(0, 500).join("\n") + (files.length > 500 ? `\n(${files.length - 500} more)` : "") || "No files.";
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
					const body = lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join("\n");
					return to < lines.length ? `${body}\n(lines ${from}-${to} of ${lines.length})` : body;
				},
			}),
			tool({
				name: "write_file",
				description: "Create or overwrite a file with complete content.",
				schema: WriteArgs,
				run: async ({ path, content }) => {
					const target = repoPath(path);
					const r = await this.exec(["bash", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "write", target], WORKDIR, content);
					return r.exitCode === 0 ? `Wrote ${target}.` : r.output;
				},
			}),
			tool({
				name: "run_command",
				description: `Run a bash command in ${WORKDIR}. Use it for npm install, tests, type checks, git and inspection.`,
				schema: RunArgs,
				run: async ({ command }) => {
					this.note(state, `run: ${command.slice(0, 200)}`);
					const r = await this.exec(["bash", "-lc", command]);
					return `exit code ${r.exitCode}\n${clip(r.output)}`;
				},
			}),
		];
	}

	private async turn(job: J, state: S) {
		if (state.turns - (state.turnsAtRunStart ?? 0) >= MAX_TURNS) throw new Error(`stopped after ${MAX_TURNS} turns without finishing`);
		const client = new OpenAI({ apiKey: this.env.OPENAI_API_KEY });
		const tools = this.tools(job, state);
		const input: ResponseInputItem[] = [
			...(state.previousResponseId ? (state.pending ?? []) : [{ role: "user" as const, content: this.kickoff(job) }]),
			...(await this.drainInbox(state)),
		];
		const response = await client.responses.create({
			model: MODEL,
			instructions: this.instructions(job),
			input,
			previous_response_id: state.previousResponseId,
			tools: openAITools(tools),
			reasoning: { effort: "high" },
			max_output_tokens: 32000,
			prompt_cache_key: `${this.kind}-${job.repo}`,
		});
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
