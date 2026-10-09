// Edit: a test:watch script that reruns the suite on every change (same flags as test).
// Usage: node test-watch-script.mjs <repo>
import { readFileSync, writeFileSync } from "node:fs";
const [repo] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(`${repo}/package.json`, "utf8"));
const scripts = {};
for (const [name, command] of Object.entries(pkg.scripts)) {
	scripts[name] = command;
	if (name === "test") scripts["test:watch"] = `${command.replace(/--reporter \w+/, "--reporter dot")} --watch`;
}
pkg.scripts = scripts;
writeFileSync(`${repo}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("package.json");
