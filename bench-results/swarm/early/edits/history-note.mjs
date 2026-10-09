// Fix: record a change in History.md, under Unreleased Changes > Improvements (made if missing).
// Usage: node history-note.mjs <repo> "<one line>"
import { readFileSync, writeFileSync } from "node:fs";
const [repo, line] = process.argv.slice(2);
const path = `${repo}/History.md`;
const text = readFileSync(path, "utf8");
const heading = "## 🚀 Improvements\n\n";
const at = text.indexOf(heading);
// Unreleased changes end where the first release ("5.1.0 / 2025-03-31") starts.
const end = text.search(/\n\d+\.\d+\.\d+ \//);
const updated = at >= 0 && (end < 0 || at < end) ? `${text.slice(0, at + heading.length)}* ${line}\n${text.slice(at + heading.length)}` : text.replace("# Unreleased Changes\n\n", `# Unreleased Changes\n\n${heading}* ${line}\n\n`);
writeFileSync(path, updated);
console.log("History.md");
