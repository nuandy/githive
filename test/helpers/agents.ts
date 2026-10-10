import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

// Agents driving plain git against a test Git server. The server runs in this
// process, so git must run asynchronously, or the server can't answer it.
const exec = promisify(execFile);

/** An agent's own clone of `url` under `work`. */
export async function agentClone(url: string, work: string, name: string) {
	const dir = join(work, name);
	await exec("git", ["clone", "--quiet", url, dir]);
	const run = async (...args: string[]) =>
		(
			await exec("git", ["-C", dir, "-c", `user.name=${name}`, "-c", `user.email=${name}@example.com`, ...args])
		).stdout.trim();
	const write = (path: string, text: string) => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	return { run, write };
}

/** Push a branch changes/<change> with the given files on top of main (or `from`), and return its head. */
export async function pushChange(
	url: string,
	work: string,
	agent: string,
	change: string,
	files: Record<string, string>,
	from?: string,
) {
	const clone = await agentClone(url, work, `${agent}-${change}-${Math.random().toString(36).slice(2, 6)}`);
	await clone.run("checkout", "--quiet", "-b", `changes/${change}`, ...(from ? [from] : []));
	for (const [path, text] of Object.entries(files)) clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "--quiet", "-m", `${change}: work`);
	await clone.run("push", "--quiet", "origin", `changes/${change}`);
	return clone.run("rev-parse", "HEAD");
}
