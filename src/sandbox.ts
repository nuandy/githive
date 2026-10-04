import { DurableObject } from "cloudflare:workers";
import OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { z } from "zod";
import { MODEL, addUsage, assertComplete, emptyUsage, openAITools, runCalls, tool, type AgentTool, type Usage } from "./agent";
import { builderGitCommandBlockReason, builderGitPushBlockReason } from "./git-command-safety";
import { COMMAND_TIMEOUT_S, WORKDIR, bootContainer, clip, gitWithToken, run } from "./container";
import type { SliceSpec } from "./types";
import type { LaneChangeCoordinator } from "./lane-change-contract";
import { BUILDER_PARK_TIMEOUT_MS, type BuilderResumeCredentials } from "./parking-contract";

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
const TURN_IN_FLIGHT = "sandbox-turn-in-flight";
const PARK_COMMAND = "sandbox-park-command";
const DEFERRED_WAKES = "sandbox-deferred-wakes";
const DELIVERED_WAKES = "sandbox-delivered-wakes";
const INBOX = "inbox";
const TIMED_OUT_PARK = "sandbox-timed-out-park";

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
	status: "queued" | "working" | "parked" | "done" | "failed";
	startedAt: string;
	finishedAt?: string;
	turns: number;
	/** `turns` when the current run started; each run (a revision) gets its own budget. */
	turnsAtRunStart?: number;
	toolCalls: number;
	nudges: number;
	usage: Usage;
	error?: string;
	parkedAt?: string;
	waitingRequestIds?: string[];
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

interface DeferredWake { eventId: string; message: string; credentials: BuilderResumeCredentials }

export abstract class SandboxAgent<J extends SandboxJob, S extends AgentState> extends DurableObject<Env> {
	private lifecycleTail: Promise<unknown> = Promise.resolve();
	private lifecycle<T>(fn: () => Promise<T>): Promise<T> { const next = this.lifecycleTail.then(fn, fn); this.lifecycleTail = next.catch(() => {}); return next; }
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
	protected async autoPark(_job: J, _state: S): Promise<boolean> { return false; }
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
		await this.ctx.storage.delete(["cancel", "inbox", "builder-last-pushed-head"]);
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

	protected async parkAgent(parkedAt: string, waitingFor: string[]) {
		return this.lifecycle(async () => {
			if (await this.ctx.storage.get(TURN_IN_FLIGHT)) { await this.ctx.storage.put(PARK_COMMAND, { parkedAt, waitingFor, applied: false }); return; }
			const { state } = await this.load(); if (!state || ["done", "failed"].includes(state.status)) return;
			state.status = "parked"; state.parkedAt = parkedAt; state.waitingRequestIds = [...waitingFor];
			this.note(state, "parked while waiting for " + waitingFor.join(", ")); await this.save(state);
			if (this.ctx.container?.running) await this.ctx.container.destroy(this.kind + " parked");
			await this.scheduleForState(state);
		});
	}

	protected async receiveWake(eventId: string, message: string, credentials: BuilderResumeCredentials): Promise<"resumed" | "deferred" | "ignored"> {
		if (!eventId.trim()) throw new Error("wake event ID must be nonempty");
		return this.lifecycle(async () => {
			const delivered = (await this.ctx.storage.get<string[]>(DELIVERED_WAKES)) ?? [];
			const pending = (await this.ctx.storage.get<DeferredWake[]>(DEFERRED_WAKES)) ?? [];
			if (delivered.includes(eventId) || pending.some((wake) => wake.eventId === eventId)) return "ignored";
			const wake = { eventId, message, credentials };
			if (await this.ctx.storage.get(TURN_IN_FLIGHT)) { await this.ctx.storage.put(DEFERRED_WAKES, [...pending, wake]); return "deferred"; }
			const { job, state } = await this.load(); if (!job || !state) return "ignored";
			return this.deliverWake(job, state, wake);
		});
	}

	private async deliverWake(job: J, state: S, wake: DeferredWake): Promise<"resumed" | "deferred" | "ignored"> {
		const delivered = (await this.ctx.storage.get<string[]>(DELIVERED_WAKES)) ?? [];
		if (delivered.includes(wake.eventId) || !["parked", "working", "queued"].includes(state.status)) return "ignored";
		const inbox = (await this.ctx.storage.get<string[]>(INBOX)) ?? []; const parked = state.status === "parked";
		if (parked) { state.status = "queued"; state.parkedAt = undefined; state.waitingRequestIds = undefined; state.finishedAt = undefined; state.error = undefined; state.nudges = 0; state.turnsAtRunStart = state.turns; this.note(state, "resumed for wake event " + wake.eventId); }
		else this.note(state, "resolution event " + wake.eventId + " queued for next turn");
		inbox.push(wake.message); delivered.push(wake.eventId);
		await this.ctx.storage.put({ job: { ...job, ...wake.credentials }, state, [INBOX]: inbox, [DELIVERED_WAKES]: delivered });
		if (parked) { if (this.ctx.container?.running) await this.ctx.container.destroy(this.kind + " resumed"); await this.ctx.storage.setAlarm(Date.now()); return "resumed"; }
		return "deferred";
	}

	protected async isParkStillTimedOut() { const { state } = await this.load(); return !!state && state.status === "parked" && !!state.parkedAt && Date.parse(state.parkedAt) + BUILDER_PARK_TIMEOUT_MS <= Date.now(); }

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
		if (!job || !state) return;
		if (state.status === "parked") { await this.handleParkedAlarm(job, state); return; }
		if (state.status !== "queued" && state.status !== "working") return;
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
					await this.ctx.storage.put(TURN_IN_FLIGHT, turnToken);
					try { await this.turn(job, state); await this.save(state); await this.reconcileAfterTurn(job, state, turnToken); }
					finally { if ((await this.ctx.storage.get<string>(TURN_IN_FLIGHT)) === turnToken) await this.ctx.storage.delete(TURN_IN_FLIGHT); }
					const refreshed = await this.ctx.storage.get<J>("job"); if (refreshed) Object.assign(job, refreshed);
			}
			if ((state.status as string) === "parked") { await this.save(state); if (this.ctx.container?.running) await this.ctx.container.destroy(this.kind + " parked"); await this.scheduleForState(state); return; }
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

	private async reconcileAfterTurn(job: J, state: S, turnToken: string) {
		await this.lifecycle(async () => {
			const park = await this.ctx.storage.get<{ parkedAt: string; waitingFor: string[] }>(PARK_COMMAND);
			if (park && (state.status === "working" || state.status === "queued")) { state.status = "parked"; state.parkedAt = park.parkedAt; state.waitingRequestIds = park.waitingFor; this.note(state, "parked while waiting for " + park.waitingFor.join(", ")); }
			const pending = (await this.ctx.storage.get<DeferredWake[]>(DEFERRED_WAKES)) ?? [];
			for (const wake of pending) await this.deliverWake(job, state, wake);
			if (pending.length) await this.ctx.storage.delete(DEFERRED_WAKES);
			await this.save(state); if (park) await this.ctx.storage.delete(PARK_COMMAND);
			if (state.status === "parked") { if (this.ctx.container?.running) await this.ctx.container.destroy(this.kind + " parked"); await this.scheduleForState(state); }
			else if (state.status === "queued") await this.scheduleForState(state);
			if ((await this.ctx.storage.get<string>(TURN_IN_FLIGHT)) === turnToken) await this.ctx.storage.delete(TURN_IN_FLIGHT);
		});
	}

	private async scheduleForState(state: S) {
		if (state.status === "parked") { const at = Date.parse(state.parkedAt ?? new Date().toISOString()) + BUILDER_PARK_TIMEOUT_MS; await this.ctx.storage.setAlarm(Math.max(Date.now(), at)); }
		else if (state.status === "queued" || state.status === "working") await this.ctx.storage.setAlarm(Date.now());
	}

	private async handleParkedAlarm(job: J, state: S) {
		const parkedAt = state.parkedAt ?? new Date().toISOString();
		if (Date.now() < Date.parse(parkedAt) + BUILDER_PARK_TIMEOUT_MS) { await this.ctx.storage.setAlarm(Date.parse(parkedAt) + BUILDER_PARK_TIMEOUT_MS); return; }
		if (await this.ctx.storage.get<string>(TIMED_OUT_PARK) === parkedAt) return;
		await (this.coordinator(job) as unknown as LaneChangeCoordinator).parkedBuilderTimedOut((job as J & { slice: { id: string } }).slice.id, parkedAt);
		const latest = (await this.load()).state;
		if (latest?.status === "parked" && latest.parkedAt === parkedAt) { await this.ctx.storage.put(TIMED_OUT_PARK, parkedAt); this.note(latest, "park timeout reported while waiting for " + (latest.waitingRequestIds ?? []).join(", ")); await this.save(latest); }
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
	protected async git(job: J, args: string[], cwd = WORKDIR, token = job.token) {
		if (this.kind === "builder" && args[0] === "push") {
			const refusal = await this.builderPushRefusal(args, cwd, token);
			if (refusal) return { exitCode: 1, output: refusal };
		}
		const result = await gitWithToken(this.ctx.container!, token, args, cwd);
		if (this.kind === "builder" && args[0] === "push" && result.exitCode === 0) {
			const head = await this.exec(["git", "rev-parse", "HEAD"], cwd);
			if (head.exitCode === 0) await this.ctx.storage.put("builder-last-pushed-head", head.output.trim());
		}
		return result;
	}

	/** The authenticated push path is the enforcement point; shell parsing is only a nudge. */
	private async builderPushRefusal(args: string[], cwd: string, token: string): Promise<string | undefined> {
		const pushArgs = args.slice(1);
		const forcePush = pushArgs.some(
			(arg) => arg === "--force" || arg.startsWith("--force-with-lease") || (/^-[^-]/.test(arg) && arg.includes("f")) || arg.startsWith("+"),
		);
		const expectedMainPush = pushArgs.includes("origin") && pushArgs.includes("HEAD:main");
		if (!expectedMainPush) return "Refusing an unrecognized builder push. Use commit_and_push to push the slice to origin/main.";

		const pushedState = await this.ctx.storage.get<{ pushes?: number }>("state");
		const lastPushedHead = await this.ctx.storage.get<string>("builder-last-pushed-head");
		const remote = await gitWithToken(this.ctx.container!, token, ["ls-remote", "--heads", "origin", "refs/heads/main"], cwd);
		if (remote.exitCode !== 0)
			return "Could not verify origin/main; refusing to push to preserve history. Retry after the remote is reachable. " + clip(remote.output, 2_000);
		const remoteHead = remote.output.trim().split(/\s+/)[0] || undefined;
		const remoteHeadIsAncestor = remoteHead ? await this.isAncestor(cwd, remoteHead) : false;
		const lastPushedHeadIsAncestor = lastPushedHead ? await this.isAncestor(cwd, lastPushedHead) : false;
		return builderGitPushBlockReason({
			remoteHead,
			remoteHeadIsAncestor,
			forcePush,
			lastPushedHead,
			lastPushedHeadIsAncestor,
			hasPushedHistory: (pushedState?.pushes ?? 0) > 0,
		});
	}

	private async isAncestor(cwd: string, commit: string) {
		const result = await this.exec(["git", "merge-base", "--is-ancestor", commit, "HEAD"], cwd);
		return result.exitCode === 0;
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
					if (this.kind === "builder") {
						const pushes = (state as S & { pushes?: number }).pushes ?? 0;
						const reason = builderGitCommandBlockReason(command, pushes > 0);
						if (reason) {
							this.note(state, `blocked unsafe git command: ${command.slice(0, 160)}`);
							return `Command refused: ${reason}`;
						}
					}
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
		if (++state.nudges > MAX_NUDGES) { if (await this.autoPark(job, state)) return; throw new Error(`${this.kind} stopped calling tools without finishing`); }
		this.note(state, `nudged: ${response.output_text.slice(0, 200)}`);
		state.pending = [{ role: "user", content: this.nudge(job) }];
	}
}
