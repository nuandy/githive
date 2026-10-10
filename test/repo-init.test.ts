import { describe, expect, it } from "vitest";
import { branchHead, defaultBranch } from "../src/git";
import { GITIGNORE, initialFiles, parseInit, writeFirstCommit } from "../src/repo-init";
import { startGitServer } from "./helpers/git-server";

// A new repo's first commit: what it holds, the options a request may ask
// for, and the commit itself, pushed to an empty repo on a real Git server.

describe("a new repo's first files", () => {
	const base = { fullName: "acme/web", holder: "Acme", year: 2026 };

	it("are a README with the repo's name and description, a .gitignore and a license, as asked", () => {
		const files = initialFiles({
			...base,
			readme: true,
			description: "The website.",
			gitignore: "node",
			license: "mit",
		});
		expect(Object.keys(files).sort()).toEqual([".gitignore", "LICENSE", "README.md"]);
		expect(files["README.md"]).toBe("# web\n\nThe website.\n");
		expect(files[".gitignore"]).toContain("node_modules/");
		expect(files.LICENSE).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Acme\n/);
	});

	it("are nothing when nothing is asked for", () => {
		expect(initialFiles({ ...base })).toEqual({});
	});

	it("keep each toolchain's build output and dependencies out of commits", () => {
		expect(GITIGNORE.python).toContain(".venv/");
		expect(GITIGNORE.go).toContain("/bin/");
		expect(GITIGNORE.rust).toContain("/target/");
	});

	it("take only the options GitHive knows", () => {
		expect(parseInit({ readme: true, description: "  x  ", gitignore: "rust", license: "mit" })).toEqual({
			readme: true,
			description: "x",
			gitignore: "rust",
			license: "mit",
		});
		expect(parseInit(undefined)).toEqual({});
		expect(() => parseInit({ gitignore: "cobol" })).toThrow(/gitignore is one of node, python, go, rust/);
		expect(() => parseInit({ license: "gpl" })).toThrow(/license is mit/);
		expect(() => parseInit("readme")).toThrow(/init is/);
	});
});

describe("the first commit", { timeout: 60_000 }, () => {
	it("gives an empty repo a main branch, which its HEAD names, holding the files", async () => {
		const server = await startGitServer();
		try {
			const url = server.repo("fresh");
			const remote = { url, token: "unused" };
			expect(await defaultBranch(remote)).toBeNull();
			const oid = await writeFirstCommit(
				remote,
				initialFiles({ fullName: "acme/fresh", holder: "acme", year: 2026, readme: true, gitignore: "python" }),
				{ name: "ada", email: "ada@users.githive.app" },
			);
			expect(await branchHead(remote, "main")).toBe(oid);
			expect(await defaultBranch(remote)).toBe("main");
			expect(server.gitIn("fresh", "show", "main:README.md")).toBe("# fresh\n");
			expect(server.gitIn("fresh", "log", "-1", "--format=%an <%ae>%n%s", "main").trim()).toBe(
				"ada <ada@users.githive.app>\nStart README.md, .gitignore",
			);
		} finally {
			await server.close();
		}
	});
});
