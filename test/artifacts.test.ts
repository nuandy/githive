import { describe, expect, it } from "vitest";
import { blobId } from "../src/artifacts";

// The staleness check compares this with the id `git rev-parse HEAD:<path>`
// prints in a builder's container, so it must be exactly Git's.
describe("blobId", () => {
	const id = (text: string) => blobId(new TextEncoder().encode(text));

	it("matches git hash-object", async () => {
		expect(await id('export const routes = ["/a"];\n')).toBe("fa8d8cffef6cf960ed55326e7ba02e8e429da429");
		expect(await id("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
		expect(await id("café ✓\n")).toBe("6b2b281e1146f9673f218f9c76042db37be95d03");
	});
});
