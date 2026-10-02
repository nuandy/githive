import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	init: vi.fn(),
	addRemote: vi.fn(),
	setConfig: vi.fn(),
	fetch: vi.fn(),
	writeBlob: vi.fn(),
	writeTree: vi.fn(),
	writeCommit: vi.fn(),
	writeRef: vi.fn(),
	push: vi.fn(),
}));
vi.mock("isomorphic-git", () => ({
	default: {
		init: io.init,
		addRemote: io.addRemote,
		setConfig: io.setConfig,
		fetch: io.fetch,
		writeBlob: io.writeBlob,
		writeTree: io.writeTree,
		writeCommit: io.writeCommit,
		writeRef: io.writeRef,
		push: io.push,
		Errors: { NotFoundError: class NotFoundError extends Error {}, PushRejectedError: class PushRejectedError extends Error {} },
	},
}));

const { appendLedger } = await import("../src/ledger-git");
const { notesRef } = await import("../src/ledger");

const remote = { url: "https://git.test/repo.git", token: "secret" };
const taskId = "retry-task";
const ref = notesRef(taskId);
const unavailable = () => Object.assign(new Error("service unavailable"), { statusCode: 503 });
const entries = [{ commit: "commit-to-note", text: "review approved", at: "2026-10-02T13:20:55.123Z" }];

beforeEach(() => {
	io.init.mockReset().mockResolvedValue(undefined);
	io.addRemote.mockReset().mockResolvedValue(undefined);
	io.setConfig.mockReset().mockResolvedValue(undefined);
	io.fetch.mockReset().mockResolvedValue({});
	io.writeBlob.mockReset().mockResolvedValue("note-blob");
	io.writeTree.mockReset().mockResolvedValue("notes-tree");
	io.writeCommit.mockReset().mockResolvedValue("notes-commit");
	io.writeRef.mockReset().mockResolvedValue(undefined);
	io.push.mockReset().mockResolvedValue({});
});

describe("ledger notes-ref transport retries", () => {
	it("retries a transient fetch of this task's notes ref", async () => {
		io.fetch.mockRejectedValueOnce(unavailable());

		await appendLedger(remote, taskId, entries, { task: { phase: "reviewing" } });

		expect(io.fetch).toHaveBeenCalledTimes(2);
		for (const [options] of io.fetch.mock.calls) {
			expect(options).toMatchObject({ ref, remoteRef: ref, remote: "origin" });
		}
	});

	it("retries a transient push of this task's notes ref", async () => {
		io.push.mockRejectedValueOnce(unavailable());

		await appendLedger(remote, taskId, entries, { task: { phase: "reviewing" } });

		expect(io.push).toHaveBeenCalledTimes(2);
		for (const [options] of io.push.mock.calls) {
			expect(options).toMatchObject({ ref, remoteRef: ref });
		}
	});
});
