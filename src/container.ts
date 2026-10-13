// Helpers for the Durable Objects that run work in a Linux container: builders, reviewers and the gate.

import { retryTransient, sleep } from "./retry";
import { INSTALL, MARKER_PATHSPECS, PROFILE, type Toolchain, detectToolchains } from "./toolchains";

export const IMAGE = "cloudflare/debian-trixie";
export const WORKDIR = "/work";
export const COMMAND_TIMEOUT_S = 300;
/** Attempts to start from a snapshot before falling back to the image. */
const SNAPSHOT_STARTS = 2;
export const SNAPSHOT_RETRY_MS = 2_000;

/**
 * Memory is billed for as long as a container runs and CPU only while it works,
 * so generous CPU and tight memory cost least. A Durable Object's container can
 * be lite, standard-1 to standard-4, or a custom 1 to 4 vCPU with at least 3 GiB per vCPU.
 */
export const INSTANCE_SIZES = {
	small: { vcpu: 1, memoryMib: 3 * 1024, diskMb: 8_000 },
	large: { vcpu: 2, memoryMib: 6 * 1024, diskMb: 12_000 },
	"standard-1": "standard-1",
} as const satisfies Record<string, ContainerStartupOptions["instance"]>;
export type InstanceSize = keyof typeof INSTANCE_SIZES;

/**
 * A saved container disk with git, the repo's toolchains, the checkout and its
 * dependencies installed (see Gate.snapshotIfDue), so containers skip that setup.
 */
export interface SetupSnapshot {
	id: string;
	/** Bytes. */
	size: number;
	at: number;
	/** What the installed dependencies came from. A container reinstalls only if these differ. */
	lockHash?: string;
	depsHash?: string;
}

/**
 * Start the container if needed, from the repo's snapshot when there is one, or
 * else from the image with git installed (the image has Node but no git). A failed
 * snapshot start is retried once because Containers is sometimes briefly unavailable,
 * and starting from the image costs much more setup time.
 */
export async function bootContainer(
	container: Container,
	size: InstanceSize = "standard-1",
	snapshot?: SetupSnapshot | null,
): Promise<"running" | "restored" | "fresh"> {
	if (container.running) return "running";
	const options = { entrypoint: ["sleep", "infinity"], enableInternet: true, instance: INSTANCE_SIZES[size] };
	for (let attempt = 1; snapshot && attempt <= SNAPSHOT_STARTS; attempt++) {
		try {
			container.start({ ...options, containerSnapshot: { id: snapshot.id } });
			const ready = await run(container, ["bash", "-c", `command -v git >/dev/null && test -d ${WORKDIR}/.git`], "/");
			if (ready.exitCode === 0) return "restored";
			// It started without its checkout, so trying again won't help.
			attempt = SNAPSHOT_STARTS;
		} catch (err) {
			console.error(
				`starting from a snapshot failed (try ${attempt} of ${SNAPSHOT_STARTS})`,
				err instanceof Error ? err.message : String(err),
			);
		}
		if (container.running) await container.destroy("the snapshot was unusable").catch(() => undefined);
		if (attempt < SNAPSHOT_STARTS) await sleep(SNAPSHOT_RETRY_MS);
	}
	container.start({ ...options, image: IMAGE });
	// WORKDIR doesn't exist until a clone, so setup runs from /.
	const apt = await run(
		container,
		["bash", "-lc", "apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null"],
		"/",
	);
	if (apt.exitCode !== 0) throw new Error(`installing git failed: ${clip(apt.output, 2_000)}`);
	return "fresh";
}

/** The toolchains beyond Node the checkout at `cwd` uses (see toolchains.ts). */
export async function repoToolchains(container: Container, cwd = WORKDIR): Promise<Toolchain[]> {
	const listed = await run(container, ["git", "ls-files", "--", ...MARKER_PATHSPECS], cwd);
	return listed.exitCode === 0 ? detectToolchains(listed.output.split("\n")) : [];
}

/** Install the checkout's toolchains and the login profile that puts them on the PATH. */
export async function installToolchains(container: Container, cwd = WORKDIR) {
	const toolchains = await repoToolchains(container, cwd);
	if (!toolchains.length) return [];
	await run(container, ["bash", "-c", "cat > /etc/profile.d/githive.sh"], "/", PROFILE);
	const installed = [];
	for (const toolchain of toolchains) {
		const ran = await run(container, ["bash", "-lc", INSTALL[toolchain]], "/", undefined, 600);
		installed.push({ toolchain, exitCode: ran.exitCode, output: ran.output });
	}
	return installed;
}

/** A SIGKILL well before the time limit came from the OOM killer rather than `timeout`. */
export function outOfMemory(exitCode: number, elapsedMs: number, timeoutS: number) {
	return exitCode === 137 && elapsedMs < timeoutS * 1000 - 5_000;
}

/** git traces its HTTP request headers here, redacted, so the Gate can count its Git requests. */
const GIT_TRACE_FILE = "/tmp/githive-git-trace";
const GIT_TRACE_ENV = { GIT_TRACE_CURL: GIT_TRACE_FILE, GIT_TRACE_CURL_NO_DATA: "1", GIT_TRACE_REDACT: "1" };

/** Git requests per repo path, and the 5xx count, since the last call. Null if the trace can't be read. */
export async function takeGitRequests(
	container: Container,
): Promise<{ paths: Map<string, number>; failed: number } | null> {
	const script = [
		`f=${GIT_TRACE_FILE}; [ -f "$f" ] || exit 0; mv "$f" "$f.taken"`,
		`grep -oE "=> Send header: (GET|POST) [^ ]+" "$f.taken" | awk '{print $5}' | sed -E 's/\?.*//' | ` +
			"sort | uniq -c",
		`echo "failed $(grep -cE '<= Recv header: HTTP/[0-9.]+ 5[0-9][0-9]' "$f.taken")"`,
		`rm -f "$f.taken"`,
	].join("\n");
	const taken = await run(container, ["bash", "-c", script]).catch(() => null);
	if (!taken || taken.exitCode !== 0) return null;
	const paths = new Map<string, number>();
	let failed = 0;
	for (const line of taken.output.split("\n")) {
		const [, count, path] = line.trim().match(/^(\d+) (\/\S*)$/) ?? [];
		if (count && path) paths.set(path, (paths.get(path) ?? 0) + Number(count));
		const failing = line.match(/^failed (\d+)$/);
		if (failing) failed = Number(failing[1]);
	}
	return { paths, failed };
}

/** A container that stopped answering: its command will never come back, and the container needs replacing. */
export class ContainerUnresponsive extends Error {}

/** How often a running command's container is checked on, and how long it has to answer. */
const CHECK_EVERY_MS = 20_000;
const ANSWER_WITHIN_MS = 15_000;
/** Checks in a row that go unanswered before the container counts as hung. */
const CHECKS_MISSED = 2;
/** How long past its own limit a command may take to come back, when the container still answers. */
const PAST_LIMIT_MS = 30_000;

/**
 * A command's output, or ContainerUnresponsive once the container stops answering a quick check while it runs. A busy
 * container still answers; one that crashed or hung doesn't, and waiting out the command's limit would cost minutes.
 */
async function whileAnswering<T>(container: Container, output: Promise<T>, timeoutS: number): Promise<T> {
	let settled = false;
	const done = output.finally(() => {
		settled = true;
	});
	const giveUpAt = Date.now() + timeoutS * 1000 + PAST_LIMIT_MS;
	const hung = (async (): Promise<never> => {
		let missed = 0;
		for (;;) {
			await pause(CHECK_EVERY_MS);
			if (settled) return new Promise<never>(() => undefined);
			if (Date.now() >= giveUpAt)
				throw new ContainerUnresponsive(`the command didn't come back ${PAST_LIMIT_MS / 1000}s past its limit`);
			missed = (await answers(container)) ? 0 : missed + 1;
			if (missed >= CHECKS_MISSED) throw new ContainerUnresponsive("the container stopped answering");
		}
	})();
	return Promise.race([done, hung]);
}

/** Whether the container runs a trivial command in time. */
async function answers(container: Container) {
	const ran = container.exec(["true"]).then(
		(process) => process.output().then(() => true),
		() => false,
	);
	return Promise.race([ran, pause(ANSWER_WITHIN_MS).then(() => false)]);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a command. `timeout` kills its whole process group, so commands like `npm test`
 * can't outlive their limit. exec() reports a missing `cwd` as "command not found".
 */
export async function run(
	container: Container,
	cmd: string[],
	cwd = WORKDIR,
	stdin?: string | ReadableStream<Uint8Array>,
	timeoutS = COMMAND_TIMEOUT_S,
) {
	const started = container.exec(["timeout", "-s", "KILL", String(timeoutS), ...cmd], {
		cwd,
		stderr: "combined",
		stdin: typeof stdin === "string" ? new Response(stdin).body! : stdin,
		env: { HOME: "/root", CI: "true", npm_config_update_notifier: "false", ...GIT_TRACE_ENV },
	});
	const result = await whileAnswering(
		container,
		started.then((process) => process.output()),
		timeoutS,
	);
	const output = new TextDecoder().decode(result.stdout);
	return {
		exitCode: result.exitCode,
		output: result.exitCode === 137 ? `${output}\n(killed after ${timeoutS}s)` : output,
	};
}

/**
 * Run git with a token passed on the command line only, never in files or the environment.
 * A network command that keeps failing (`attempts` times, 4 by default) still returns its last result for the builder
 * to see.
 */
export async function gitWithToken(
	container: Container,
	token: string,
	args: string[],
	cwd = WORKDIR,
	user?: string,
	timeoutS = COMMAND_TIMEOUT_S,
	attempts?: number,
) {
	const secret = token.split("?expires=")[0];
	// GitHub wants Basic auth with x-access-token and the installation token.
	const authorization = user ? `Basic ${btoa(`${user}:${secret}`)}` : `Bearer ${secret}`;
	const command = ["git", "-c", `http.extraHeader=Authorization: ${authorization}`, ...args];
	if (!isNetworkGitCommand(args)) return run(container, command, cwd, undefined, timeoutS);

	const attempt = async () => {
		const result = await run(container, command, cwd, undefined, timeoutS);
		if (result.exitCode !== 0 && isTransientGitOutput(result.output)) {
			throw Object.assign(new Error("Transient Git transport failure"), {
				status: 503,
				statusCode: 503,
				commandResult: result,
			});
		}
		return result;
	};
	try {
		return await retryTransient(attempt, attempts ? { maxAttempts: attempts } : {});
	} catch (err) {
		const result = (err as { commandResult?: Awaited<ReturnType<typeof run>> } | null)?.commandResult;
		if (result) return result;
		throw err;
	}
}

function isNetworkGitCommand(args: string[]) {
	return args[0] === "clone" || args[0] === "fetch" || args[0] === "push";
}

const NETWORK_FAILURE = new RegExp(
	"\\b(?:" +
		[
			"could not resolve (?:host|proxy)",
			"failed to connect",
			"connection (?:timed out|reset|refused)",
			"operation timed out",
			"network is unreachable",
			"temporary failure in name resolution",
			"recv failure",
			"send failure",
			"remote end hung up unexpectedly",
			"unexpected disconnect",
			"early eof",
		].join("|") +
		")\\b",
	"i",
);

/** Only transport errors are retried. Local and permanent Git failures pass through. */
function isTransientGitOutput(output: string) {
	return (
		/\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:408|429|5\d\d)\b/i.test(output) ||
		/returned error:\s*(?:408|429|5\d\d)\b/i.test(output) ||
		NETWORK_FAILURE.test(output) ||
		/\bcurl\s*\(?\s*(?:7|28|35|52|56)\)?\b/i.test(output)
	);
}

/** Keep the start and end of long output; the end usually holds the error. */
export function clip(text: string, limit = 12_000) {
	if (text.length <= limit) return text;
	const head = text.slice(0, 2_000);
	const tail = text.slice(-(limit - 2_000));
	return `${head}\n…(${text.length - limit} characters omitted)…\n${tail}`;
}
