import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

// A Gate's container whose commands run on this machine, with its git, in a folder standing in for the checkout,
// so what a Gate reads and pushes against a test Git server is what git really does.

/** A container whose commands run here: the checkout (/work) in `dir`, nothing installed (git is already here). */
export function localContainer(dir: string) {
	const local = (s: string) => s.replaceAll("/work", dir);
	const container = {
		running: false,
		start: () => void (container.running = true),
		destroy: async () => void (container.running = false),
		setInactivityTimeout: async () => undefined,
		exec: async (cmd: string[], options: { cwd: string; stdin?: ReadableStream }) => {
			// `timeout -s KILL <seconds>` first: not on every machine, and not needed here.
			const args = (cmd[0] === "timeout" ? cmd.slice(4) : cmd).map(local);
			const stdin = options.stdin ? Buffer.from(await new Response(options.stdin).arrayBuffer()) : undefined;
			const installing = args.join(" ").includes("apt-get");
			return {
				output: () =>
					new Promise<{ exitCode: number; stdout: Uint8Array }>((resolve) => {
						if (installing) return resolve({ exitCode: 0, stdout: new Uint8Array() });
						// Ignore this machine's git config, such as its identity, since a container has none.
						const [command, ...commandArgs] = args;
						if (command === undefined) throw new Error("an empty command");
						const child = spawn(command, commandArgs, {
							cwd: local(options.cwd),
							env: {
								...process.env,
								GIT_TERMINAL_PROMPT: "0",
								GIT_CONFIG_GLOBAL: "/dev/null",
								GIT_CONFIG_NOSYSTEM: "1",
								HOME: tmpdir(),
							},
						});
						const out: Buffer[] = [];
						child.stdout.on("data", (b) => out.push(b));
						child.stderr.on("data", (b) => out.push(b));
						child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: new Uint8Array(Buffer.concat(out)) }));
						child.on("error", (err) => resolve({ exitCode: 127, stdout: new TextEncoder().encode(String(err)) }));
						if (stdin !== undefined) child.stdin.end(stdin);
						else child.stdin.end();
					}),
			};
		},
	};
	return container;
}
