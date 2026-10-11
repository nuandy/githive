import type { Remote } from "../../git";

// Ready-to-run git commands for the access credentials hands out, so an agent connected only over MCP doesn't have
// to work out how to send a token: Artifacts takes it as a Bearer header, without the "?..." it carries.

/** The header git sends to `remote`, as `git -c` takes it, for that URL only. */
function authOption(remote: Remote) {
	return `http.${remote.url}.extraHeader="${authHeader(remote)}"`;
}

/** The same header, kept in the clone's config for later fetches and pushes. */
function authConfig(remote: Remote) {
	return `git config http.${remote.url}.extraHeader "${authHeader(remote)}"`;
}

function authHeader(remote: Remote) {
	const token = remote.token.split("?")[0] ?? remote.token;
	return `Authorization: Bearer ${token}`;
}

/**
 * Commands to start a change, push it to the agent's own fork, and push again later. The clone comes from the fork,
 * so a crowd of agents starting at once doesn't all clone the project repo; only what the project's branch gained
 * since the fork was made is fetched from it, and the change starts from there.
 */
export function ownChangeCommands(input: { project: Remote; fork: Remote; into: string; change: string }) {
	const { project, fork, into, change } = input;
	const branch = `changes/${change}`;
	return {
		setup: [
			`git -c ${authOption(fork)} clone --origin fork ${fork.url} ${change}`,
			`cd ${change}`,
			authConfig(fork),
			`git remote add origin ${project.url}`,
			authConfig(project),
			`git fetch origin ${into}`,
			`git checkout -b ${branch} origin/${into}`,
		],
		push: `git push fork ${branch}`,
	};
}

/** Commands to fetch a change under review beside the project's branch, and see what it changes. */
export function reviewCommands(input: { project: Remote; fork: Remote; into: string; change: string; head: string }) {
	const { project, fork, into, change, head } = input;
	const directory = `review-${change}`;
	return {
		setup: [
			`git -c ${authOption(project)} clone --branch ${into} ${project.url} ${directory}`,
			`cd ${directory}`,
			authConfig(fork),
			`git fetch ${fork.url} changes/${change}`,
			`git checkout --detach ${head}`,
		],
		diff: `git diff origin/${into}...${head}`,
	};
}
