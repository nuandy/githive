// Shared helpers for Durable Objects that run work in a Linux container:
// agents (builders, reviewers) and the integration gate.

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

/** Run git with a token on this one command only; it never lands in files or the environment. */
export function gitWithToken(container: Container, token: string, args: string[], cwd = WORKDIR) {
	const secret = token.split("?expires=")[0];
	return run(container, ["git", "-c", `http.extraHeader=Authorization: Bearer ${secret}`, ...args], cwd);
}

/** Keep the start and end of long output; the end usually holds the error. */
export function clip(text: string, limit = 12_000) {
	if (text.length <= limit) return text;
	const head = text.slice(0, 2_000);
	const tail = text.slice(-(limit - 2_000));
	return `${head}\n…(${text.length - limit} characters omitted)…\n${tail}`;
}
