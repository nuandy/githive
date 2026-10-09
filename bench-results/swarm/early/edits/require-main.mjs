// Edit: the deprecated `module.parent` check (DEP0144) becomes `require.main === module` in the examples.
// Usage: node require-main.mjs <repo>   (prints the files it changed)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [repo] = process.argv.slice(2);
const files = execFileSync("git", ["-C", repo, "grep", "-l", "module.parent", "--", "examples"], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const file of files) {
	const path = `${repo}/${file}`;
	const before = readFileSync(path, "utf8");
	const after = before.replace(/!module\.parent/g, "require.main === module");
	if (after !== before) { writeFileSync(path, after); console.log(file); }
}
