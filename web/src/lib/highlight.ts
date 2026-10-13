import type { HLJSApi, LanguageFn } from "highlight.js";

// The Code tab's syntax colors: highlight.js's core and a dozen common languages, each loaded only when a file in it
// is shown, so the dashboard's own bundle carries none of it. highlight.js answers in HTML spans; linesOf reads them
// back into lines of tokens, which CodeBrowser draws as React elements in the theme's code colors (theme.css,
// --code-*), never as HTML.

const LANGUAGES: Record<string, () => Promise<{ default: LanguageFn }>> = {
	typescript: () => import("highlight.js/lib/languages/typescript"),
	javascript: () => import("highlight.js/lib/languages/javascript"),
	json: () => import("highlight.js/lib/languages/json"),
	css: () => import("highlight.js/lib/languages/css"),
	xml: () => import("highlight.js/lib/languages/xml"),
	python: () => import("highlight.js/lib/languages/python"),
	go: () => import("highlight.js/lib/languages/go"),
	rust: () => import("highlight.js/lib/languages/rust"),
	yaml: () => import("highlight.js/lib/languages/yaml"),
	bash: () => import("highlight.js/lib/languages/bash"),
	markdown: () => import("highlight.js/lib/languages/markdown"),
};

/** Each language by its files' extensions and the names a Markdown fence gives it. */
const NAMES: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	typescript: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	javascript: "javascript",
	json: "json",
	jsonc: "json",
	css: "css",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
	py: "python",
	python: "python",
	go: "go",
	golang: "go",
	rs: "rust",
	rust: "rust",
	yml: "yaml",
	yaml: "yaml",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	shell: "bash",
	md: "markdown",
	markdown: "markdown",
};

/** The language to color a file in, by its extension, or a fence's name; undefined for one the tab doesn't color. */
export function languageOf(path: string, name?: string): string | undefined {
	if (name) return NAMES[name.toLowerCase()];
	const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
	return extension ? NAMES[extension] : undefined;
}

/** A run of text and the highlight.js scopes it's in, outermost first. */
export interface Token {
	text: string;
	scopes: string[];
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };

/**
 * highlight.js's HTML as lines of tokens. It writes only spans with a class and text with &, <, >, " and ' escaped,
 * so that's all this reads; a span that runs over lines is carried onto each.
 */
export function linesOf(html: string): Token[][] {
	const lines: Token[][] = [[]];
	const scopes: string[] = [];
	for (const [, open, close, text] of html.matchAll(/<span class="([^"]*)">|(<\/span>)|([^<]+)/g)) {
		if (open !== undefined) scopes.push(open);
		else if (close) scopes.pop();
		else if (text) {
			const parts = text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]!).split("\n");
			parts.forEach((part, index) => {
				if (index > 0) lines.push([]);
				if (part) lines.at(-1)!.push({ text: part, scopes: [...scopes] });
			});
		}
	}
	return lines;
}

/** Each scope's color, from the theme. A scope with none takes the one around it. */
const COLORS: Record<string, string> = {
	keyword: "text-code-keyword",
	"selector-tag": "text-code-keyword",
	name: "text-code-keyword",
	doctag: "text-code-keyword",
	string: "text-code-string",
	regexp: "text-code-string",
	link: "text-code-string",
	"selector-attr": "text-code-string",
	number: "text-code-literal",
	literal: "text-code-literal",
	symbol: "text-code-literal",
	bullet: "text-code-literal",
	comment: "text-code-comment italic",
	quote: "text-code-comment italic",
	title: "text-code-title",
	section: "text-code-title font-semibold",
	"selector-id": "text-code-title",
	"selector-class": "text-code-title",
	type: "text-code-type",
	built_in: "text-code-type",
	meta: "text-code-type",
	"title class_": "text-code-type",
	attr: "text-code-attr",
	attribute: "text-code-attr",
	property: "text-code-attr",
	variable: "text-code-attr",
	"template-variable": "text-code-attr",
	"selector-pseudo": "text-code-attr",
	addition: "text-good",
	deletion: "text-bad",
	emphasis: "italic",
	strong: "font-semibold",
};

/** A token's classes: its innermost scope's that has a color ("hljs-title class_" before plain "title"). */
export function tokenClass(scopes: string[]): string | undefined {
	for (const scope of [...scopes].reverse()) {
		const name = scope.replace(/^hljs-/, "");
		const color = COLORS[name] ?? COLORS[name.split(" ")[0]!];
		if (color) return color;
	}
	return undefined;
}

let core: Promise<HLJSApi> | undefined;

/** `text` highlighted as `language`, as lines of tokens; null if it can't be (an unknown language, or it failed). */
export async function highlight(text: string, language: string): Promise<Token[][] | null> {
	const load = LANGUAGES[language];
	if (!load) return null;
	try {
		core ??= import("highlight.js/lib/core").then((module) => module.default);
		const hljs = await core;
		if (!hljs.getLanguage(language)) hljs.registerLanguage(language, (await load()).default);
		return linesOf(hljs.highlight(text, { language, ignoreIllegals: true }).value);
	} catch {
		return null;
	}
}
