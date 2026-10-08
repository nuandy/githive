// Shared helpers for Durable Objects that run work in a Linux container:
// agents (builders, reviewers) and the integration gate.

import { retryTransient } from "./retry";
import { INSTALL, MARKER_PATHSPECS, PROFILE, type Toolchain, detectToolchains } from "./toolchains";

export const IMAGE = "cloudflare/debian-trixie";
export const WORKDIR = "/work";
export const COMMAND_TIMEOUT_S = 300;

/**
 * The sizes GitHive starts containers at. Memory is paid for as long as a
 * container runs, CPU only while it works, so generous CPU and tight memory
 * cost least. Containers started by a Durable Object take lite, standard-1
 * to standard-4, or a custom size of 1 to 4 vCPU with at least 3 GiB each.
 */
export const INSTANCE_SIZES = {
	/** 1 vCPU, 3 GiB: a quarter less memory than standard-1, and twice its CPU. */
	small: { vcpu: 1, memoryMib: 3 * 1024, diskMb: 8_000 },
	large: { vcpu: 2, memoryMib: 6 * 1024, diskMb: 12_000 },
	"standard-1": "standard-1",
} as const satisfies Record<string, ContainerStartupOptions["instance"]>;
export type InstanceSize = keyof typeof INSTANCE_SIZES;

/**
 * A repo's setup, saved: a container's disk with git, the repo's toolchains,
 * the project checked out at WORKDIR and its main branch's dependencies
 * installed (see Gate.snapshotIfDue). Containers start from it in seconds
 * instead of setting all that up again.
 */
export interface SetupSnapshot {
	id: string;
	/** Its size, in bytes. */
	size: number;
	/** When it was taken. */
	at: number;
	/** What the installed dependencies came from (Gate.lockHash, the toolchains' depsHash): a container from it reinstalls only if these differ. */
	lockHash?: string;
	depsHash?: string;
}

/**
 * Start the container if needed, at `size`: from the repo's snapshot when
 * there is one ("restored": its checkout and dependencies are there), or
 * from the image with git installed ("fresh": the managed image has Node 24
 * but no git). A snapshot that won't start, or starts without its checkout,
 * is given up on for the image.
 */
export async function bootContainer(container: Container, size: InstanceSize = "standard-1", snapshot?: SetupSnapshot | null): Promise<"running" | "restored" | "fresh"> {
	if (container.running) return "running";
	const options = { entrypoint: ["sleep", "infinity"], enableInternet: true, instance: INSTANCE_SIZES[size] };
	if (snapshot) {
		try {
			container.start({ ...options, containerSnapshot: { id: snapshot.id } });
			const ready = await run(container, ["bash", "-c", `command -v git >/dev/null && test -d ${WORKDIR}/.git`], "/");
			if (ready.exitCode === 0) return "restored";
		} catch (err) {
			console.error("starting from a snapshot failed", err instanceof Error ? err.message : String(err));
		}
		if (container.running) await container.destroy("the snapshot was unusable").catch(() => undefined);
	}
	container.start({ ...options, image: IMAGE });
	// WORKDIR doesn't exist until a clone, so setup runs from /.
	const apt = await run(container, ["bash", "-lc", "apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null"], "/");
	if (apt.exitCode !== 0) throw new Error(`installing git failed: ${clip(apt.output, 2_000)}`);
	return "fresh";
}

/** The toolchains beyond Node the checkout at `cwd` uses (see toolchains.ts). */
export async function repoToolchains(container: Container, cwd = WORKDIR): Promise<Toolchain[]> {
	const listed = await run(container, ["git", "ls-files", "--", ...MARKER_PATHSPECS], cwd);
	return listed.exitCode === 0 ? detectToolchains(listed.output.split("\n")) : [];
}

/**
 * Install the toolchains the checkout uses (each a no-op once there), and the
 * login profile that puts them on the PATH. Returns how each install went.
 */
export async function installToolchains(container: Container, cwd = WORKDIR) {
	const toolchains = await repoToolchains(container, cwd);
	if (!toolchains.length) return [];
	await run(container, ["bash", "-c", "cat > /etc/profile.d/githive.sh"], "/", PROFILE);
	const installed = [];
	for (const toolchain of toolchains) {
		const r = await run(container, ["bash", "-lc", INSTALL[toolchain]], "/", undefined, 600);
		installed.push({ toolchain, exitCode: r.exitCode, output: r.output });
	}
	return installed;
}

/**
 * Whether a command was killed for memory: SIGKILL (exit 137) well before
 * its time limit, which `timeout` would otherwise have been the one to send.
 */
export function outOfMemory(exitCode: number, elapsedMs: number, timeoutS: number) {
	return exitCode === 137 && elapsedMs < timeoutS * 1000 - 5_000;
}

/**
 * Run a command. `timeout` runs it in its own process group and kills all of
 * it, so commands like `npm test` can't outlive their limit.
 * Note: exec() reports a missing `cwd` as "command not found".
 */
export async function run(container: Container, cmd: string[], cwd = WORKDIR, stdin?: string, timeoutS = COMMAND_TIMEOUT_S) {
	const process = await container.exec(["timeout", "-s", "KILL", String(timeoutS), ...cmd], {
		cwd,
		stderr: "combined",
		stdin: stdin === undefined ? undefined : new Response(stdin).body!,
		env: { HOME: "/root", CI: "true", npm_config_update_notifier: "false" },
	});
	const result = await process.output();
	const output = new TextDecoder().decode(result.stdout);
	return { exitCode: result.exitCode, output: result.exitCode === 137 ? `${output}\n(killed after ${timeoutS}s)` : output };
}

/**
 * Run git with a token on this one command only; it never lands in files or the environment.
 * Network commands retain their result shape even when a transient failure persists, so
 * callers can report the final command's exit code and output to the builder.
 */
export async function gitWithToken(container: Container, token: string, args: string[], cwd = WORKDIR) {
	const secret = token.split("?expires=")[0];
	const command = ["git", "-c", `http.extraHeader=Authorization: Bearer ${secret}`, ...args];
	if (!isNetworkGitCommand(args)) return run(container, command, cwd);

	try {
		return await retryTransient(async () => {
			const result = await run(container, command, cwd);
			if (result.exitCode !== 0 && isTransientGitOutput(result.output)) {
				throw Object.assign(new Error("Transient Git transport failure"), {
					status: 503,
					statusCode: 503,
					commandResult: result,
				});
			}
			return result;
		});
	} catch (err) {
		const result = (err as { commandResult?: Awaited<ReturnType<typeof run>> } | null)?.commandResult;
		if (result) return result;
		throw err;
	}
}

function isNetworkGitCommand(args: string[]) {
	return args[0] === "clone" || args[0] === "fetch" || args[0] === "push";
}

/** Only retry recognizable transport errors; local and permanent Git failures pass through. */
function isTransientGitOutput(output: string) {
	return /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:408|429|5\d\d)\b/i.test(output)
		|| /returned error:\s*(?:408|429|5\d\d)\b/i.test(output)
		|| /\b(?:could not resolve (?:host|proxy)|failed to connect|connection (?:timed out|reset|refused)|operation timed out|network is unreachable|temporary failure in name resolution|recv failure|send failure|remote end hung up unexpectedly|unexpected disconnect|early eof)\b/i.test(output)
		|| /\bcurl\s*\(?\s*(?:7|28|35|52|56)\)?\b/i.test(output);
}

/** Keep the start and end of long output; the end usually holds the error. */
export function clip(text: string, limit = 12_000) {
	if (text.length <= limit) return text;
	const head = text.slice(0, 2_000);
	const tail = text.slice(-(limit - 2_000));
	return `${head}\n…(${text.length - limit} characters omitted)…\n${tail}`;
}
