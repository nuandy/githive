import { describe, expect, it } from "vitest";
import { repoOfUrl } from "../src/git-http";

describe("a Git server's error", () => {
	it("names the repo from the URL it came from", () => {
		expect(
			repoOfUrl(
				"https://acct.artifacts.cloudflare.net/git/blueprint/nuandy--web.git/info/refs?service=git-upload-pack",
			),
		).toBe("nuandy--web");
		expect(repoOfUrl("https://git.test/ns/fork--web--agent-1/git-receive-pack")).toBe("fork--web--agent-1");
		expect(repoOfUrl("http://127.0.0.1:4000/p")).toBe("p");
	});
});
