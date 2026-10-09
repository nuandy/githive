// Edit: assert.equal( becomes assert.strictEqual( in the test suite.
// Usage: node strict-asserts.mjs <repo>   (prints the files it changed)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [repo] = process.argv.slice(2);
for (const file of execFileSync("git", ["-C", repo, "ls-files", "test/*.js", "test/**/*.js"]).toString().split("\n").filter(Boolean)) {
	const path = `${repo}/${file}`;
	const before = readFileSync(path, "utf8");
	const after = before.replace(/\bassert\.equal\(/g, "assert.strictEqual(");
	if (after !== before) { writeFileSync(path, after); console.log(file); }
}
