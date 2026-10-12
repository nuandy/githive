import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MergeCheck } from "../api";
import { inlineText } from "../test/fixtures";
import { ConflictPanel } from "./ConflictPanel";

// The conflict panel on a change's page: the files its last merge check found changed on both sides, who changed
// each on the branch, the conflict markers, and the commands its agent runs next.

const HEAD = "b1c2d3e4f5a6b7c8";
const MAIN = "9f8e7d6c5b4a3210";
const markers = [
	"<<<<<<< ours (changes/c-1)",
	"total = sum(lines)",
	"=======",
	"total = sum(lines) - refunds",
	">>>>>>> origin/main",
].join("\n");

const conflict: MergeCheck = {
	head: HEAD,
	into: "main",
	branchHead: MAIN,
	clean: false,
	conflicts: ["src/billing/invoice.ts", "README.md"],
	touchedBy: [
		{
			file: "src/billing/invoice.ts",
			commit: "6584265aaaaaaaaa",
			change: "c-7",
			agent: "alice",
			intent: "add partial refunds",
		},
		{ file: "src/billing/invoice.ts", commit: "1234567bbbbbbbbb", change: "c-2", agent: "bob" },
		{ file: "README.md", commit: "abcdef0ccccccccc", author: "mainline", intent: "readme" },
	],
	hunks: [
		{ file: "src/billing/invoice.ts", content: markers, truncated: false },
		{ file: "README.md", content: "@@ line 1 @@\n<<<<<<< ours (changes/c-1)\nours", truncated: true },
	],
	fix: [
		"git fetch origin main && git merge origin/main",
		"# resolve src/billing/invoice.ts README.md so both changes make sense, then:",
		"git add src/billing/invoice.ts README.md && git commit --no-edit",
		"git push fork changes/c-1",
		"call status; once the new commit is approved, merge again",
	],
	outsideClaim: [],
};

const render = (merge: MergeCheck, head: string | null = HEAD) =>
	renderToStaticMarkup(<ConflictPanel merge={merge} head={head} repo="acme/shop" />);

describe("the conflict panel", () => {
	it("lists each conflicted file with who changed it on the branch since the change left it", () => {
		const html = render(conflict);
		const text = inlineText(html);
		expect(text).toContain("Conflicts with main");
		expect(text).toContain(
			"2 files changed on both sides, as its agent's last status found on b1c2d3e against main at 9f8e7d6.",
		);
		// A GitHive change: its change, agent and intent, and the commit, each linked.
		expect(text).toContain("c-7 by alice · “add partial refunds” 6584265");
		expect(html).toContain('href="#/repos/acme/shop/changes/c-7"');
		expect(html).toContain('href="#/repos/acme/shop/code?ref=6584265aaaaaaaaa"');
		expect(text).toContain("c-2 by bob 1234567");
		// A plain push: its author and subject.
		expect(text).toContain("a plain push by mainline · “readme” abcdef0");
		// Each file names only its own commits.
		const readme = html.slice(html.indexOf("<code>README.md</code>"));
		expect(readme).not.toContain("c-7");
	});

	it("shows the hunks in a monospace block, marking one cut at 4 KB", () => {
		const html = render(conflict);
		expect(html).toContain(
			'<pre tabindex="0"><code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; ours (changes/c-1)\ntotal = sum(lines)\n=======',
		);
		expect(html.match(/conflict-panel__hunk--cut/g)).toHaveLength(1);
		expect(inlineText(html)).toContain("Cut at 4 KB: the whole file is in the agent's clone.");
		const invoice = html.slice(
			html.indexOf("<code>src/billing/invoice.ts</code>"),
			html.indexOf("<code>README.md</code>"),
		);
		expect(invoice).not.toContain("Cut at 4 KB");
	});

	it("gives the agent's next commands, with a copy button, for its clone", () => {
		const html = render(conflict);
		const text = inlineText(html);
		expect(text).toContain("The agent's next commands");
		expect(text).toContain("where origin is the project and fork its copy");
		expect(html).toContain(
			"<code>git fetch origin main &amp;&amp; git merge origin/main\n# resolve src/billing/invoice.ts README.md so both",
		);
		// The copy block holds only the shell commands; what to call after is said beneath it.
		expect(html).toContain("git push fork changes/c-1</code>");
		expect(html).not.toMatch(/<code>[^<]*call status/);
		expect(text).toContain("Then: call status; once the new commit is approved, merge again.");
		expect(html).toMatch(
			/<button type="button" class="copy-block__button" aria-label="Copy commands: git fetch origin main/,
		);
		expect(html).toContain(">Copy commands</button>");
	});

	it("says when the change has moved since the check, and shows nothing for a clean merge", () => {
		expect(inlineText(render(conflict, "ffff000011112222"))).toContain(
			"The change has moved since: its agent's next status checks it again.",
		);
		expect(inlineText(render(conflict))).not.toContain("moved since");
		expect(render({ into: "main", branchHead: MAIN, clean: true, outsideClaim: [] })).toBe("");
	});

	it("names who changed a file only when it's known, and lists at most 20 files", () => {
		const files = Array.from({ length: 23 }, (_, k) => `f${k}.txt`);
		const many = render({ into: "main", branchHead: MAIN, clean: false, conflicts: files });
		const text = inlineText(many);
		expect(text).toContain("23 files changed on both sides");
		expect(many.match(/conflict-panel__file"/g)).toHaveLength(20);
		expect(text).toContain("Who changed it on main wasn't found.");
		expect(text).toContain("And 3 more files.");
		expect(text).not.toContain("The agent's next commands");
	});
});
