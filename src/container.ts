// Shared helpers for Durable Objects that run work in a Linux container:
// agents (builders, reviewers) and the integration gate.

import { retryTransient } from "./retry";

export const IMAGE = "cloudflare/debian-trixie";
export const WORKDIR = "/work";
export const COMMAND_TIMEOUT_S = 300;

/** Start the container if needed and install git (the managed image has Node 24 but no git). */
export async function bootContainer(container: Container) {
	if (!container.running)
		container.start({ image: IMAGE, entrypoint: ["sleep", "infinity"], enableInternet: true, instance: "standard-1" });
	// WORKDIR doesn't exist until a clone, so setup runs from /.
	const apt = await run(container, ["bash", "-lc", "apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null"], "/");
	if (apt.exitCode !== 0) throw new Error(`installing git failed: ${clip(apt.output, 2_000)}`);
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
