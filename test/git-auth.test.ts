import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { branchHead } from "../src/git";

// isomorphic-git asks a Git server without credentials first, gets a 401, and
// asks again, leaving the 401's body unread; in a Worker, a few such reads side
// by side held every connection a request may open, and the runtime cancelled
// responses to break the stall. GitHive sends its credentials with the first request.

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
const OID = "1234567890abcdef1234567890abcdef12345678";

let close: (() => void) | undefined;
afterEach(() => close?.());

/** A Git server that refuses a request without credentials, and lists one branch to one with them. */
async function guarded() {
	const seen: (string | undefined)[] = [];
	const server = createServer((req, res) => {
		seen.push(req.headers.authorization);
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
