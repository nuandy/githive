import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Real people's data lives in production now: a database migration may add,
// never take away. These fail the build on a migration that would destroy
// data, so it can't reach a deploy by accident. Something that truly has to
// go is a decision for a person, made outside a routine change.

const root = join(import.meta.dirname, "..");

describe("D1 migrations", () => {
	const files = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();

	it("are numbered in order, one after another", () => {
		expect(files.map((f) => Number(f.slice(0, 4)))).toEqual(files.map((_, i) => i + 1));
	});

	it("only ever add: no dropping, deleting, emptying or renaming away", () => {
		for (const file of files) {
			// Comments aside: they may well talk about what a migration doesn't do.
			const sql = readFileSync(join(root, "migrations", file), "utf8").replace(/--.*$/gm, "");
			expect(sql, file).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)\b/i);
			expect(sql, file).not.toMatch(/\bDELETE\s+FROM\b/i);
			expect(sql, file).not.toMatch(/\bTRUNCATE\b/i);
			expect(sql, file).not.toMatch(/\bALTER\s+TABLE\s+\S+\s+(DROP|RENAME)\b/i);
			expect(sql, file).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
		}
	});
});

describe("Durable Object migrations", () => {
	// Deleting a class deletes every object's storage. These were decided by a person, before there were users.
	const DECIDED = new Set(["v8", "v11", "v12"]);

	for (const config of ["wrangler.jsonc", "wrangler.bench.jsonc"]) {
		it(`delete no class in ${config} beyond those already decided`, () => {
			const text = readFileSync(join(root, config), "utf8").replace(/^\s*\/\/.*$/gm, "");
			const tags = [...text.matchAll(/\{\s*"tag":\s*"(v\d+)"([^}]*)\}/g)];
			expect(tags.length).toBeGreaterThan(0);
			for (const [, tag, rest] of tags) if (/deleted_classes/.test(rest)) expect(DECIDED.has(tag), `${config} ${tag} deletes a Durable Object class`).toBe(true);
			// Nor renames one away from its data without saying so here.
			for (const [, tag, rest] of tags) if (/renamed_classes|transferred_classes/.test(rest)) expect.fail(`${config} ${tag} renames or transfers a class: decide it deliberately and allow it here`);
		});
	}
});
