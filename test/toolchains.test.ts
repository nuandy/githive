import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DEPENDENCIES, INSTALL, PROFILE, detectToolchains } from "../src/toolchains";
import { FakeStorage } from "./fakes/env";

// Toolchains beyond Node: which a repo uses, and the Gate installing them and
// their dependencies before its checks, against a container that answers
// commands from a script (no real container).

const { Gate } = await import("../src/gate");

describe("which toolchains a repo uses", () => {
	it("reads them from its files, in any folder", () => {
		expect(detectToolchains(["package.json", "src/index.ts"])).toEqual([]);
		expect(detectToolchains(["pyproject.toml"])).toEqual(["python"]);
		expect(detectToolchains(["api/requirements-dev.txt"])).toEqual(["python"]);
		expect(detectToolchains(["services/billing/go.mod", "crates/core/Cargo.toml", "tools/setup.py"])).toEqual([
			"python",
			"go",
			"rust",
		]);
	});

	it("finds Bun from its lockfile or bunfig.toml", () => {
		expect(detectToolchains(["package.json", "bun.lock"])).toEqual(["bun"]);
		expect(detectToolchains(["apps/web/bun.lockb"])).toEqual(["bun"]);
		expect(detectToolchains(["bunfig.toml"])).toEqual(["bun"]);
		expect(detectToolchains(["docs/bun.lock.md"])).toEqual([]);
	});

	it("installs a Bun project's dependencies exactly as its lockfile pins them", () => {
		expect(DEPENDENCIES.bun.script).toContain("bun install --frozen-lockfile");
		expect(INSTALL.bun).toContain("BUN_INSTALL=/usr/local");
	});

	it("isn't fooled by names that only contain a marker", () => {
		expect(detectToolchains(["docs/go.mod.md", "notes/Cargo.toml.bak", "my-pyproject.toml.txt"])).toEqual([]);
	});

	it("installs and fetches with scripts bash can parse", () => {
		for (const script of [PROFILE, ...Object.values(INSTALL), ...Object.values(DEPENDENCIES).map((d) => d.script)])
			execFileSync("bash", ["-n", "-c", script]);
	});
});

/** A container that answers each command from the first matching rule, recording what ran. */
function fakeContainer(rules: [RegExp, { exitCode?: number; output?: string }][]) {
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
	return { container, ran };
}

const setUp = (gate: InstanceType<typeof Gate>, container: unknown) =>
	(
		gate as unknown as { setUpToolchains(c: unknown): Promise<{ command: string; exitCode: number; output: string }[]> }
	).setUpToolchains(container);

describe("the Gate's toolchains", () => {
	it("installs nothing for a Node-only repo", async () => {
		const { container, ran } = fakeContainer([[/^git ls-files/, { output: "" }]]);
		expect(await setUp(new Gate({ storage: new FakeStorage() } as never, {} as never), container)).toEqual([]);
		expect(ran).toHaveLength(1);
	});

	it("installs Go and its modules once, then skips the modules while go.mod and go.sum are unchanged", async () => {
		const { container, ran } = fakeContainer([
			[/^git ls-files/, { output: "go.mod\ngo.sum\nmain.go\n" }],
			[/sha256sum/, { output: "hash-1\n" }],
		]);
		const gate = new Gate({ storage: new FakeStorage() } as never, {} as never);
		expect(await setUp(gate, container)).toEqual([{ command: "go mod download", exitCode: 0, output: "" }]);
		expect(ran.some((c) => c.includes("/etc/profile.d/githive.sh"))).toBe(true);
		expect(ran.some((c) => c.includes("go.dev/dl"))).toBe(true);
		ran.length = 0;
		const again = await setUp(gate, container);
		expect(again).toEqual([{ command: "go mod download", exitCode: 0, output: expect.stringMatching(/^Skipped/) }]);
		expect(ran.some((c) => c.includes("go mod download"))).toBe(false);
	});

	it("reports a failed install as a failed check, and installs no dependencies", async () => {
		const { container, ran } = fakeContainer([
			[/^git ls-files/, { output: "Cargo.toml\n" }],
			[/rustup/, { exitCode: 1, output: "curl: (6) Could not resolve host: sh.rustup.rs" }],
		]);
		const results = await setUp(new Gate({ storage: new FakeStorage() } as never, {} as never), container);
		expect(results).toEqual([
			{ command: "install rust", exitCode: 1, output: expect.stringContaining("Could not resolve host") },
		]);
		expect(ran.some((c) => c.includes("cargo fetch"))).toBe(false);
	});

	it("stops at a failed dependency install, and tries it again next time", async () => {
		let fail = true;
		const { container } = fakeContainer([
			[/^git ls-files/, { output: "pyproject.toml\n" }],
			[/sha256sum/, { output: "hash-1\n" }],
		]);
		const exec = container.exec;
		container.exec = async (cmd: string[]) =>
			cmd.join(" ").includes("uv sync") && fail
				? { output: async () => ({ exitCode: 1, stdout: new TextEncoder().encode("No solution found") }) }
				: exec(cmd);
		const gate = new Gate({ storage: new FakeStorage() } as never, {} as never);
		expect(await setUp(gate, container)).toEqual([
			{ command: expect.stringMatching(/^uv sync/), exitCode: 1, output: "No solution found" },
		]);
		fail = false;
		expect(await setUp(gate, container)).toEqual([
			{ command: expect.stringMatching(/^uv sync/), exitCode: 0, output: "" },
		]);
	});
});
