import { gitWithToken, run } from "./container";
import { fail } from "./errors";

// Importing a private repo. Artifacts imports only public remotes, so a private one is cloned in a container with the
// person's token and pushed into the new, empty repo. The token goes to Git only as a request header, the way
// gitWithToken passes every token, so it never lands in a URL, a file, the environment or an error message.

/** Where the bare clone goes in the import's container. */
const CLONE_DIR = "/import";

/** GitHub takes a token as the password of any user; this is the name its docs use. */
const TOKEN_USER = "x-access-token";

export interface PrivateImport {
	source: { url: string; branch?: string; token: string };
	/** The new repo's remote and a token that writes it. */
	target: { url: string; token: string };
}

/** Throws a clear 400 unless `url` is an HTTPS Git URL with no credentials in it. */
export function checkImportUrl(url: string) {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return fail(400, `not a URL: ${url}`);
	}
	if (parsed.protocol !== "https:") fail(400, "a private repo is imported over HTTPS");
	if (parsed.username || parsed.password) fail(400, "put the token in its own field, not in the URL");
}

/** What a failed clone means for the person importing, without Git's own output, which names the URL. */
function cloneFailure(output: string) {
	if (/authentication failed|could not read username|403|401/i.test(output))
		return "GitHub refused the token: check it can read this repository's contents, and hasn't expired";
	if (/remote branch .* not found/i.test(output)) return "that branch isn't in the repository";
	if (/not found/i.test(output))
		return "no such repository, or the token can't see it: check the URL and the token's repository access";
	return "the repository couldn't be cloned";
}

/**
 * Clones one branch of a private repo, with its history, and pushes it to the new repo. Returns the branch. Runs in
 * a container made for this import alone, which the caller destroys afterwards.
 */
export async function importWithToken(container: Container, input: PrivateImport): Promise<{ branch: string }> {
	const { source, target } = input;
	const branchArgs = source.branch ? ["--branch", source.branch] : [];
	const cloneArgs = ["clone", "--bare", "--single-branch", ...branchArgs, source.url, CLONE_DIR];
	const cloned = await gitWithToken(container, source.token, cloneArgs, "/", TOKEN_USER);
	if (cloned.exitCode !== 0) fail(400, cloneFailure(cloned.output));

	const head = await run(container, ["git", "symbolic-ref", "--short", "HEAD"], CLONE_DIR);
	const branch = source.branch ?? head.output.trim();
	if (!branch) fail(400, "the repository has no branch to import");

	const pushArgs = ["push", target.url, `refs/heads/${branch}:refs/heads/${branch}`];
	const pushed = await gitWithToken(container, target.token, pushArgs, CLONE_DIR);
	if (pushed.exitCode !== 0) fail(502, "the cloned repository couldn't be saved to GitHive; try again");
	return { branch };
}
