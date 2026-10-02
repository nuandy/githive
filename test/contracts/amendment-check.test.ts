import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage, fakeEnv, task } from "../fakes/env";

const mocks = vi.hoisted(() => ({
	decide: vi.fn(),
	clone: vi.fn(),
}));
vi.mock("../../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/artifacts")>()),
	headOf: vi.fn(async () => "base-head"),
	fileVersion: vi.fn(async () => null),
	remoteFor: vi.fn(async (_artifacts: unknown, repo: string) => ({ url: `https://git.test/${repo}.git`, token: `token-${repo}` })),
}));
vi.mock("../../src/contract-owner", () => ({ NEW_FILE: "(new)", decideAmendment: mocks.decide }));
vi.mock("../../src/git", () => ({ Workspace: { clone: mocks.clone } }));
vi.mock("../../src/ledger-git", () => ({ appendLedger: vi.fn(async () => undefined), readLedger: vi.fn(async () => []) }));

const { Coordinator } = await import("../../src/coordinator");

beforeEach(() => {
	mocks.decide.mockReset().mockResolvedValue({ approve: true, reason: "needed" });
	mocks.clone.mockReset();
});

describe("contract amendment checking", () => {
	it("checks the proposed overlay and does not commit it when the contract check fails", async () => {
		const storage = new FakeStorage();
		const fake = fakeEnv();
		const path = "test/contracts/proposed.test.ts";
		const check = vi.fn().mockResolvedValue({
			status: "failed",
			errors: [{ file: path, line: 1, code: 2345, message: "type mismatch" }],
			checked: [path],
			unchecked: [],
		});
		const checker = { check, dispose: vi.fn(async () => undefined) };
		Object.assign(fake.env, { CONTRACT_CHECKER: { getByName: vi.fn(() => checker) } });
		await storage.put("task", task({ contracts: [path] }));
		const coordinator = new Coordinator({ storage } as never, fake.env as never);
		const proposal = { path, content: "expect(value).toBe(true);", reason: "add an assertion", basedOn: null };

		const result = await coordinator.proposeAmendment("a", proposal);

		expect(check).toHaveBeenCalledWith(expect.objectContaining({ commit: "base-head", contracts: { [path]: proposal.content } }));
		expect(result.status).toBe("failed");
		expect(result.decision).toContain("Contract check failed");
		expect(mocks.clone).not.toHaveBeenCalled();
	});
});
