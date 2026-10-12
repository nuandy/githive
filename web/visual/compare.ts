// Compares two captures (capture.ts) shot by shot and writes an HTML report of every difference.
//
//   node web/visual/compare.ts <before-label> <after-label> [--only <regex>]
//
// A shot passes when it has the same size and no pixel differs beyond pixelmatch's threshold (anti-aliased pixels
// are ignored). The report, web/visual/out/<after>-vs-<before>.html, shows before, after and the difference.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const OUT = new URL("./out", import.meta.url).pathname;
const [before, after] = process.argv.slice(2);
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? new RegExp(process.argv[onlyAt + 1]!) : null;
if (!before || !after) {
	console.error("usage: node web/visual/compare.ts <before-label> <after-label> [--only <regex>]");
	process.exit(2);
}

const beforeDir = join(OUT, before);
const afterDir = join(OUT, after);
const diffDir = join(OUT, `${after}-vs-${before}`);

interface Result {
	shot: string;
	problem: string;
	diff?: string;
}

const results: Result[] = [];
let passed = 0;

const shots = readdirSync(beforeDir)
	.filter((name) => name.endsWith(".png") && (!only || only.test(name)))
	.sort();
for (const shot of shots) {
	const afterPath = join(afterDir, shot);
	if (!existsSync(afterPath)) {
		results.push({ shot, problem: "missing" });
		continue;
	}
	const a = PNG.sync.read(readFileSync(join(beforeDir, shot)));
	const b = PNG.sync.read(readFileSync(afterPath));
	if (a.width !== b.width || a.height !== b.height) {
		results.push({ shot, problem: `size ${a.width}×${a.height} → ${b.width}×${b.height}` });
		continue;
	}
	const diff = new PNG({ width: a.width, height: a.height });
	const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
	if (changed === 0) {
		passed++;
		continue;
	}
	mkdirSync(diffDir, { recursive: true });
	writeFileSync(join(diffDir, shot), PNG.sync.write(diff));
	results.push({ shot, problem: `${changed} pixels differ`, diff: join(diffDir, shot) });
}
for (const shot of readdirSync(afterDir).filter((name) => name.endsWith(".png") && (!only || only.test(name))))
	if (!existsSync(join(beforeDir, shot))) results.push({ shot, problem: "new (no baseline)" });

const report = join(OUT, `${after}-vs-${before}.html`);
const row = (result: Result) => {
	const image = (dir: string) =>
		existsSync(join(dir, result.shot)) ? `<img src="${join(dir, result.shot).slice(OUT.length + 1)}">` : "";
	return `<section><h2>${result.shot} <small>${result.problem}</small></h2><div class="trio">
		<figure>${image(beforeDir)}<figcaption>${before}</figcaption></figure>
		<figure>${image(afterDir)}<figcaption>${after}</figcaption></figure>
		<figure>${result.diff ? image(diffDir) : ""}<figcaption>difference</figcaption></figure></div></section>`;
};
writeFileSync(
	report,
	`<!doctype html><meta charset="utf-8"><title>${after} vs ${before}</title>
<style>body{font:14px system-ui;margin:24px}h2{font-size:15px}small{color:#b13527;font-weight:400;margin-left:8px}
.trio{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}figure{margin:0}img{width:100%;border:1px solid #ccc}
figcaption{color:#666;font-size:12px}</style>
<h1>${after} vs ${before}: ${passed} of ${shots.length} match</h1>${results.map(row).join("\n")}`,
);

console.log(`${passed} of ${shots.length} shots match`);
for (const result of results) console.log(`  ${result.shot}: ${result.problem}`);
if (results.length) {
	console.log(`report: ${report}`);
	process.exitCode = 1;
}
