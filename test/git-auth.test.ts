import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { branchHead } from "../src/git";
import { countingRequests, gitFetch, gitTimeout } from "../src/git-http";

// isomorphic-git asks a Git server without credentials first, gets a 401, and
// asks again, leaving the 401's body unread; in a Worker, a few such reads side
// by side held every connection a request may open, and the runtime cancelled
// responses to break the stall. GitHive sends its credentials with the first request.

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
const OID = "1234567890abcdef1234567890abcdef12345678";

let close: (() => void) | undefined;
afterEach(() => close?.());

/** A Git server that refuses a request without credentials, and lists one branch to one with them; busy (500) for the first `busy` requests, silent (never answering) for the first `silent`. */
async function guarded(busy = 0, silent = 0) {
	const seen: (string | undefined)[] = [];
	const server = createServer((req, res) => {
		seen.push(req.headers.authorization);
		if (seen.length <= silent) return;
		if (seen.length <= busy) {
			res.writeHead(500).end("busy");
			return;
		}
		if (!req.headers.authorization) {
			res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end("credentials, please");
			return;
		}
		res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement" });
		res.end(`${pkt("# service=git-upload-pack\n")}0000${pkt(`${OID} refs/heads/main\0side-band-64k\n`)}0000`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	close = () => server.close();
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/project.git`, seen };
}

describe("a Git server asking for credentials", () => {
	it("gets them with the first request: no 401 to leave unread, and one round trip", async () => {
		const { url, seen } = await guarded();
		expect(await branchHead({ url, token: "secret?expires=1" }, "main")).toBe(OID);
		expect(seen).toEqual([`Basic ${btoa("x:secret")}`]);
	});
});

describe("a busy Git server", { timeout: 30_000 }, () => {
	it("is asked again for a few seconds, and each request is counted for the call it's made in", async () => {
		const { url, seen } = await guarded(2);
		const counting = countingRequests(() => branchHead({ url, token: "secret" }, "main"));
		expect(await counting.done).toBe(OID);
		expect(seen).toHaveLength(3);
		expect(counting.requests.get("project")).toEqual({ requests: 3, failed: 2 });
	});

	it("is asked again when it accepts a request and never answers, the request taken for a server failure", async () => {
		const was = gitTimeout.ms;
		gitTimeout.ms = 300;
		try {
			const { url, seen } = await guarded(0, 2);
			const counting = countingRequests(() => branchHead({ url, token: "secret" }, "main"));
			expect(await counting.done).toBe(OID);
			expect(seen).toHaveLength(3);
			expect(counting.requests.get("project")).toEqual({ requests: 3, failed: 2 });
			// GitHive's own Git requests (a push, a shallow fetch): a 504 to handle as any server failure.
			const silent = await guarded(0, 1);
			expect((await gitFetch(`${silent.url}/git-receive-pack`, { method: "POST", body: "0000" })).status).toBe(504);
		} finally {
			gitTimeout.ms = was;
		}
	});

	it("is given up on after 5 tries, and no caller tries again on top", async () => {
		const { url, seen } = await guarded(100);
		await expect(branchHead({ url, token: "secret" }, "main")).rejects.toThrow(/500.*\(project, 5 tries\)/);
		expect(seen).toHaveLength(5);
	});
});
