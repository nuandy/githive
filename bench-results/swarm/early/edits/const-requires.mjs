// Edit: `var x = require(...)` becomes `const x = require(...)` in the given directory's .js files.
// Usage: node const-requires.mjs <repo> <dir>   (prints the files it changed)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [repo, dir] = process.argv.slice(2);
const files = execFileSync("git", ["-C", repo, "ls-files", `${dir}/*.js`, `${dir}/**/*.js`]).toString().split("\n").filter(Boolean);
for (const file of [...new Set(files)]) {
	const path = `${repo}/${file}`;
	const before = readFileSync(path, "utf8");
	// Top-level, nested and destructured: var x = require(...), var { a } = require(...).
	const after = before.replace(/^(\s*)var (\w+|\{[^}=]*\}) = require\(/gm, "$1const $2 = require(");
	if (after !== before) { writeFileSync(path, after); console.log(file); }
}
