import { describe, expect, it } from "vitest";
import { highlight, languageOf, linesOf, tokenClass } from "./highlight";

describe("a file's language", () => {
	it("is told by its extension, among the languages the Code tab colors", () => {
		expect(languageOf("src/lib/cart.ts")).toBe("typescript");
		expect(languageOf("src/App.tsx")).toBe("typescript");
		expect(languageOf("vite.config.mjs")).toBe("javascript");
		expect(languageOf("package.json")).toBe("json");
		expect(languageOf("index.html")).toBe("xml");
		expect(languageOf("scripts/seed.py")).toBe("python");
		expect(languageOf("main.go")).toBe("go");
		expect(languageOf("lib.rs")).toBe("rust");
		expect(languageOf(".github/workflows/ci.yml")).toBe("yaml");
		expect(languageOf("deploy.sh")).toBe("bash");
		expect(languageOf("README.md")).toBe("markdown");
		expect(languageOf("styles/app.CSS")).toBe("css");
		expect(languageOf("LICENSE")).toBeUndefined();
		expect(languageOf("photo.png")).toBeUndefined();
	});

	it("is told by a fence's name too", () => {
		expect(languageOf("", "sh")).toBe("bash");
		expect(languageOf("", "ts")).toBe("typescript");
		expect(languageOf("", "cobol")).toBeUndefined();
	});
});

describe("highlighted code", () => {
	it("splits highlight.js's spans into lines of tokens, a span across lines carried onto each", () => {
		const html =
			'<span class="hljs-comment">/* one\ntwo */</span>\n<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;&lt;b&gt; &amp;&quot;</span>;';
		expect(linesOf(html)).toEqual([
			[{ text: "/* one", scopes: ["hljs-comment"] }],
			[{ text: "two */", scopes: ["hljs-comment"] }],
			[
				{ text: "const", scopes: ["hljs-keyword"] },
				{ text: " a = ", scopes: [] },
				{ text: '"<b> &"', scopes: ["hljs-string"] },
				{ text: ";", scopes: [] },
			],
		]);
	});

	it("colors a token from the theme, by its innermost scope that has a color", () => {
		expect(tokenClass(["hljs-keyword"])).toBe("text-code-keyword");
		expect(tokenClass(["hljs-string", "hljs-subst"])).toBe("text-code-string");
		expect(tokenClass(["hljs-title function_"])).toBe("text-code-title");
		expect(tokenClass(["hljs-title class_"])).toBe("text-code-type");
		expect(tokenClass(["hljs-comment"])).toBe("text-code-comment italic");
		expect(tokenClass(["hljs-number"])).toBe("text-code-literal");
		expect(tokenClass([])).toBeUndefined();
		expect(tokenClass(["hljs-punctuation"])).toBeUndefined();
	});

	it("highlights with highlight.js, loading the language it needs", async () => {
		const lines = await highlight('export const total = (n: number) => n * 2; // twice\n"x"', "typescript");
		expect(lines).toHaveLength(2);
		const first = lines![0]!;
		expect(first.map((token) => token.text).join("")).toBe("export const total = (n: number) => n * 2; // twice");
		expect(first.find((token) => token.text === "export")?.scopes).toEqual(["hljs-keyword"]);
		expect(first.find((token) => token.text.includes("twice"))?.scopes).toEqual(["hljs-comment"]);
	});
});
