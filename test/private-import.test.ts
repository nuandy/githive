import { describe, expect, it } from "vitest";
import { checkImportUrl, importWithToken } from "../src/private-import";

// Importing a private repo: cloned in a container with the person's token, then pushed into the new repo. The token
// goes to Git only as a request header, never in a URL or an error.

const TOKEN = "github_pat_secret";
const SOURCE = "https://github.com/acme/private-app.git";
const TARGET = { url: "https://artifacts.test/acme--app.git", token: "art_v1_target?expires=1" };

/** A container that answers each command from the first matching rule, recording what ran. */
function fakeContainer(rules: [RegExp, { exitCode?: number; output?: string }][] = []) {
	const ran: string[] = [];
	const container = {
		running: true,
		exec: async (cmd: string[]) => {
			const line = cmd.slice(4).join(" "); // past `timeout -s KILL <s>`
			ran.push(line);
			const rule = rules.find(([pattern]) => pattern.test(line))?.[1] ?? {};
			return {
				output: async () => ({ exitCode: rule.exitCode ?? 0, stdout: new TextEncoder().encode(rule.output ?? "") }),
			};
		},
	};
	return { container: container as unknown as Container, ran };
}

const failure = (work: Promise<unknown>) =>
	work.then(
		() => "",
		(err: Error) => err.message,
	);

describe("importing a private repo", () => {
	it("clones the branch with the token as a header, and pushes it to the new repo with the repo's own token", async () => {
		const { container, ran } = fakeContainer();
		const source = { url: SOURCE, branch: "main", token: TOKEN };
		expect(await importWithToken(container, { source, target: TARGET })).toEqual({ branch: "main" });
		const [clone, push] = [ran.find((line) => line.includes(" clone ")), ran.find((line) => line.includes(" push "))];
		const basic = btoa(`x-access-token:${TOKEN}`);
		expect(clone).toBe(
			`git -c http.extraHeader=Authorization: Basic ${basic} clone --bare --single-branch --branch main ${SOURCE} /import`,
		);
		expect(push).toBe(
			`git -c http.extraHeader=Authorization: Bearer art_v1_target push ${TARGET.url} refs/heads/main:refs/heads/main`,
		);
		// The token is in no URL and in no other command.
		expect(ran.filter((line) => line.includes(TOKEN))).toEqual([]);
	});

	it("imports the repo's default branch when none is named", async () => {
		const { container } = fakeContainer([[/symbolic-ref/, { output: "trunk\n" }]]);
		const imported = await importWithToken(container, { source: { url: SOURCE, token: TOKEN }, target: TARGET });
		expect(imported).toEqual({ branch: "trunk" });
	});

	it("says what went wrong without repeating Git's output", async () => {
		const refused = fakeContainer([
			[/ clone /, { exitCode: 128, output: `fatal: Authentication failed for '${SOURCE}'` }],
		]);
		const message = await failure(
			importWithToken(refused.container, { source: { url: SOURCE, token: TOKEN }, target: TARGET }),
		);
		expect(message).toMatch(/^\[400\] GitHub refused the token/);
		expect(message).not.toContain(SOURCE);
		const missing = fakeContainer([[/ clone /, { exitCode: 128, output: "remote: Repository not found." }]]);
		expect(
			await failure(importWithToken(missing.container, { source: { url: SOURCE, token: TOKEN }, target: TARGET })),
		).toMatch(/no such repository, or the token can't see it/);
	});

	it("takes only an HTTPS URL, with no credentials in it", () => {
		expect(() => checkImportUrl(SOURCE)).not.toThrow();
		expect(() => checkImportUrl("git@github.com:acme/app.git")).toThrow(/\[400\]/);
		expect(() => checkImportUrl("http://github.com/acme/app.git")).toThrow(/over HTTPS/);
		expect(() => checkImportUrl(`https://me:${TOKEN}@github.com/acme/app.git`)).toThrow(/its own field/);
	});
});
