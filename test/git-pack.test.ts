import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { concat, pktLine } from "../src/git-fetch";
import { Chunks, packInAnswer } from "../src/git-pack";
import { MemoryFS } from "../src/memory-fs";

/** A small real pack: one blob. */
async function somePack() {
	const fs = new MemoryFS();
	await git.init({ fs, dir: "/p" });
	const blob = await git.writeBlob({ fs, dir: "/p", blob: new TextEncoder().encode("hello\n") });
	return (await git.packObjects({ fs, dir: "/p", oids: [blob] })).packfile!;
}

/** An upload-pack answer without side-band, split into chunks the way a stream delivers it. */
const answer = (...parts: Uint8Array[]) => {
	const bytes = concat(parts);
	return new Chunks([bytes.subarray(0, 7), bytes.subarray(7, 30), bytes.subarray(30)]);
};

describe("the pack in an upload-pack answer", () => {
	it("is what follows the NAK, up to its checksum", async () => {
		const pack = await somePack();
		expect(concat(packInAnswer(answer(...pktLine("NAK\n"), pack)).parts)).toEqual(pack);
	});

	it("leaves out a flush packet some servers send after the pack", async () => {
		const pack = await somePack();
		const found = packInAnswer(answer(...pktLine("NAK\n"), pack, new TextEncoder().encode("0000")));
		expect(concat(found.parts)).toEqual(pack);
	});

	it("refuses a pack whose checksum doesn't match, and says the server's error", async () => {
		const pack = await somePack();
		const broken = pack.slice();
		broken[broken.length - 1]! ^= 1;
		expect(() => packInAnswer(answer(...pktLine("NAK\n"), broken))).toThrow("checksum");
		expect(() => packInAnswer(answer(...pktLine("ERR upload-pack: not our ref\n")))).toThrow("not our ref");
	});
});
