// Starting and stopping a Gate's container: the clone a fresh one starts with, and the log lines that show what a
// container did and cost.
import { type InstanceSize, WORKDIR, clip, gitWithToken, run, takeGitRequests } from "./container";
import { describeCounts, type GitRequests, repoOfUrl } from "./git-http";

/** When and for which repo a container started, recorded for the log line at stop. */
export interface ContainerStart {
	at: number;
	repo: string | null;
	own: boolean;
	size: InstanceSize;
}

/** Logs the container's limits, then clones the project into an empty working directory. */
export async function cloneProject(container: Container, base: { remote: string; token: string }, size: InstanceSize) {
	const limits = await run(
		container,
		["bash", "-c", "echo $(nproc) cpus, $(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo) MiB"],
		"/",
	);
	console.log(`gate container started at ${size}: ${limits.output.trim()}`);
	await run(container, ["rm", "-rf", WORKDIR], "/");
	const clone = await gitWithToken(container, base.token, ["clone", "--quiet", base.remote, WORKDIR], "/");
	if (clone.exitCode !== 0) throw new Error(`clone of the project failed: ${clip(clone.output, 2_000)}`);
}

/** Logs how long a stopped container ran, which shows what it cost. */
export function logStopped(started: ContainerStart) {
	console.log(
		JSON.stringify({
			event: "check container stopped",
			repo: started.repo,
			gate: started.own ? "repo" : "change",
			size: started.size,
			seconds: Math.round((Date.now() - started.at) / 1000),
		}),
	);
}

/** Logs the Git requests this container made for one unit of work, by kind of repo. */
export async function logGitRequests(container: Container | undefined, what: string, repo: string | undefined) {
	if (!container?.running) return;
	const taken = await takeGitRequests(container);
	if (!taken?.paths.size) return;
	const requests: GitRequests = new Map();
	for (const [path, n] of taken.paths) {
		const name = repoOfUrl(`https://git${path}`);
		const seen = requests.get(name) ?? { requests: 0, failed: 0 };
		requests.set(name, { requests: seen.requests + n, failed: 0 });
	}
	console.log(
		`gate ${what} on ${repo ?? "-"} ${describeCounts(repo ?? "", requests, new Map())}${taken.failed ? ` (${taken.failed} failed)` : ""}`,
	);
}
