import type { Node, Query } from "web-tree-sitter";
import { engine, type Lang } from "./engine";
import { relativeTarget } from "./resolve";

// What one TypeScript or JavaScript file declares and imports, and where it uses what it imports. Ported from
// artifact-submission's reader (src/reader/reader.mjs), without its git and file reads.

export type DeclarationKind = "function" | "class" | "interface" | "type" | "enum" | "variable" | "method" | "field";

export type Declaration = {
	/** "loadSettings", or "Store.get" for a member of class Store. */
	name: string;
	kind: DeclarationKind;
	exported: boolean;
	/**
	 * Its interface: the text up to its body (the whole text for types, interfaces and enums), with comments cut
	 * and whitespace collapsed. Overloads and repeated names are joined with "; ".
	 */
	signature: string;
	/** A class member: `name` is "Class.member". */
	member?: true;
	/** The file's default export, or a member of it: importers name it "default". */
	default?: true;
};

export type ImportedName = { imported: string; local: string; uses: number[] };
export type NamespaceImport = { local: string; uses: { name: string; lines: number[] }[] };
export type Import = {
	/** The specifier as written. */
	from: string;
	/**
	 * For a relative specifier, the repo path it names, before extension and index lookup ("../settings" from
	 * src/jobs/sync.ts is "src/settings"); `resolvesTo` and `resolveImport` find the file.
	 */
	resolved?: string;
	/** Named and default imports ("default" is imported as `local`), with the lines that use each. */
	names: ImportedName[];
	/** `import * as local`: each name used through it ("Store" for `local.Store`), or "*" for `local` itself. */
	namespace?: NamespaceImport;
};
export type FileFacts = { declarations: Declaration[]; imports: Import[] };

/** Files over this many characters (about 1 MB) are skipped: parsing them costs too much for a hint. */
export const MAX_PARSE_CHARS = 1_000_000;
/** Lines kept per imported name: enough to point at the uses, bounded however often a file uses one. */
export const MAX_USE_LINES = 20;

const EXTENSIONS: Record<string, Lang> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
};

/** The grammar for a path, or null when it isn't TypeScript or JavaScript. */
export function languageOf(path: string): Lang | null {
	const ext = /\.[^./]+$/.exec(path)?.[0];
	return (ext !== undefined && EXTENSIONS[ext]) || null;
}

/**
 * The declarations and imports of one file. Null when it isn't TS/JS, is over MAX_PARSE_CHARS, has a syntax error
 * anywhere, or the parser fails. Never throws: a file that can't be read is skipped, never an error.
 */
export async function fileFacts(path: string, source: string): Promise<FileFacts | null> {
	const lang = languageOf(path);
	if (!lang) return null;
	if (source.length > MAX_PARSE_CHARS) {
		console.log(`footprint: skipped ${path}: ${source.length} characters, over ${MAX_PARSE_CHARS}`);
		return null;
	}
	let tree = null;
	try {
		const { parser, query } = await engine(lang);
		tree = parser.parse(source);
		if (!tree || tree.rootNode.hasError) return null;
		return { declarations: declarationsOf(tree.rootNode, source, query), imports: importsOf(path, tree.rootNode) };
	} catch (err) {
		console.error(`footprint: ${path} left unparsed: ${String(err)}`);
		return null;
	} finally {
		// Trees live in the wasm heap, not the JS one: free each.
		tree?.delete();
	}
}

// ───────────────────────── declarations ─────────────────────────

const line = (node: Node) => node.startPosition.row + 1;

/** Source text between two offsets of `node`, with comments cut out and whitespace collapsed. */
function cut(node: Node, text: string, start: number, end: number): string {
	const comments = node
		.descendantsOfType("comment")
		.filter((c) => c.startIndex >= start && c.endIndex <= end)
		.sort((a, b) => a.startIndex - b.startIndex);
	let out = "";
	let at = start;
	for (const c of comments) {
		if (c.startIndex < at) continue;
		out += `${text.slice(at, c.startIndex)} `;
		at = c.endIndex;
	}
	out += text.slice(at, end);
	return out
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\s;,:=]+$/, "");
}

const whole = (node: Node, text: string) => cut(node, text, node.startIndex, node.endIndex);

/** Text from the start of `node` up to its body, or all of it when it has no body. */
function header(node: Node, text: string) {
	const body = node.childForFieldName("body");
	return cut(node, text, node.startIndex, body ? body.startIndex : node.endIndex);
}

/** The comparison key of a signature: no whitespace, no trailing commas. */
export function compact(signature: string) {
	return signature.replace(/\s+/g, "").replace(/,([)\]}>])/g, "$1");
}

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

type Exports = { listed: Set<string>; defaults: Set<string> };

/** Names exported by `export { a, b as c }` (no source) and `export default a`, and which of them are the default. */
function exportList(root: Node): Exports {
	const listed = new Set<string>();
	const defaults = new Set<string>();
	for (const n of root.namedChildren) {
		if (n.type !== "export_statement" || n.childForFieldName("source")) continue;
		const clause = n.namedChildren.find((c) => c.type === "export_clause");
		for (const s of clause?.namedChildren ?? []) {
			const name = s.type === "export_specifier" ? s.childForFieldName("name")?.text : undefined;
			if (!name) continue;
			listed.add(name);
			if (s.childForFieldName("alias")?.text === "default") defaults.add(name);
		}
		const value = n.childForFieldName("value");
		if (value?.type === "identifier") {
			listed.add(value.text);
			defaults.add(value.text);
		}
	}
	return { listed, defaults };
}

const isDefaultExport = (outer: Node) =>
	outer.type === "export_statement" && outer.children.some((c) => c.type === "default");

function exportPrefix(outer: Node) {
	if (outer.type !== "export_statement") return "";
	return isDefaultExport(outer) ? "export default " : "export ";
}

type Shape = Omit<Declaration, "name">;

function tsjsDecl(node: Node, kind: string, base: string, owner: string | null, text: string, exp: Exports): Shape {
	const parent = node.parent!;
	// Members of a class: exported with their class, unless private.
	if (owner) {
		const classNode = parent.parent!;
		const classOuter = classNode.parent?.type === "export_statement" ? classNode.parent : classNode;
		const isPrivate =
			node.namedChildren.some((c) => c.type === "accessibility_modifier" && c.text === "private") ||
			(node.childForFieldName("name") ?? node.childForFieldName("property"))?.type === "private_property_identifier";
		const shape: Shape = {
			kind: kind as DeclarationKind,
			exported: (classOuter.type === "export_statement" || exp.listed.has(owner)) && !isPrivate,
			signature: "",
			member: true,
		};
		if (isDefaultExport(classOuter) || exp.defaults.has(owner)) shape.default = true;
		if (kind === "field") {
			const value = node.childForFieldName("value");
			if (value && FUNCTION_VALUES.has(value.type))
				shape.signature = `${cut(node, text, node.startIndex, value.startIndex)} = ${header(value, text)}`;
			else shape.signature = value ? cut(node, text, node.startIndex, value.startIndex) : whole(node, text);
		} else shape.signature = header(node, text);
		return shape;
	}
	// Variables: one declaration per declarator. A function value makes it a function.
	if (kind === "variable") {
		const decl = parent;
		const outer = decl.parent?.type === "export_statement" ? decl.parent : decl;
		const prefix = `${exportPrefix(outer)}${decl.child(0)?.text ?? ""} `;
		const value = node.childForFieldName("value");
		const isFunction = value !== null && FUNCTION_VALUES.has(value.type);
		const shape: Shape = {
			kind: isFunction ? "function" : "variable",
			exported: outer.type === "export_statement" || exp.listed.has(base),
			signature: !value
				? prefix + whole(node, text)
				: isFunction
					? `${prefix}${cut(node, text, node.startIndex, value.startIndex)} = ${header(value, text)}`
					: prefix + cut(node, text, node.startIndex, value.startIndex),
		};
		if (exp.defaults.has(base)) shape.default = true;
		return shape;
	}
	const outer = parent.type === "export_statement" ? parent : node;
	const prefix = exportPrefix(outer);
	let signature: string;
	if (kind === "class") signature = prefix + header(node, text);
	else if (kind === "function")
		signature = prefix + (node.childForFieldName("body") ? header(node, text) : whole(node, text));
	// interface, type, enum: the whole text is the interface.
	else signature = prefix + whole(node, text);
	const shape: Shape = {
		kind: kind as DeclarationKind,
		exported: outer.type === "export_statement" || exp.listed.has(base),
		signature,
	};
	if (isDefaultExport(outer) || exp.defaults.has(base)) shape.default = true;
	return shape;
}

/** The top-level declarations and class members of one parsed file, in source order. */
function declarationsOf(root: Node, text: string, query: Query): Declaration[] {
	const exp = exportList(root);
	const out = new Map<string, Declaration>();
	for (const m of query.matches(root)) {
		const decl = m.captures.find((c) => c.name.startsWith("decl."));
		if (!decl) continue;
		const nameNode = m.captures.find((c) => c.name === "name")?.node;
		const classNode = m.captures.find((c) => c.name === "class")?.node;
		const base = nameNode ? nameNode.text : "default";
		const owner = classNode ? classNode.text : null;
		const name = owner ? `${owner}.${base}` : base;
		const d = tsjsDecl(decl.node, decl.name.slice("decl.".length), base, owner, text, exp);
		const seen = out.get(name);
		if (seen) {
			// Overloads and repeated names: one declaration with every signature.
			seen.signature = `${seen.signature}; ${d.signature}`;
			seen.exported ||= d.exported;
			if (d.default) seen.default = true;
		} else out.set(name, { name, ...d });
	}
	return [...out.values()];
}

// ───────────────────────── imports and their uses ─────────────────────────

function stringValue(node: Node | null): string | null {
	if (!node) return null;
	if (node.type !== "string") return node.text;
	return node.namedChildren
		.filter((c) => c.type === "string_fragment")
		.map((c) => c.text)
		.join("");
}

const FUNCTIONS = new Set([
	"function_declaration",
	"function_expression",
	"function",
	"generator_function",
	"generator_function_declaration",
	"arrow_function",
	"method_definition",
]);
const CLASSES = new Set(["class_declaration", "class", "abstract_class_declaration"]);
const NAMED_DECLARATIONS = new Set([
	"function_declaration",
	"generator_function_declaration",
	"class_declaration",
	"abstract_class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
]);

/** The names a binding pattern (parameter, declarator name, destructuring) introduces. */
function patternNames(node: Node | null, out: Set<string>) {
	if (!node) return;
	switch (node.type) {
		case "identifier":
		case "shorthand_property_identifier_pattern":
			out.add(node.text);
			break;
		case "pair_pattern":
			patternNames(node.childForFieldName("value"), out);
			break;
		case "assignment_pattern":
		case "object_assignment_pattern":
			patternNames(node.childForFieldName("left"), out);
			break;
		case "required_parameter":
		case "optional_parameter":
			patternNames(node.childForFieldName("pattern"), out);
			break;
		default:
			for (const c of node.namedChildren) if (c.type !== "type_annotation") patternNames(c, out);
	}
}

function typeParameterNames(node: Node, out: Set<string>) {
	for (const tp of node.childForFieldName("type_parameters")?.namedChildren ?? []) {
		const name = tp.childForFieldName("name");
		if (name) out.add(name.text);
	}
}

function declaratorNames(declaration: Node, out: Set<string>) {
	for (const d of declaration.namedChildren)
		if (d.type === "variable_declarator") patternNames(d.childForFieldName("name"), out);
}

/** `var` declarations anywhere in a function body, not crossing into nested functions or classes. */
function varNames(node: Node, out: Set<string>) {
	for (const c of node.namedChildren) {
		if (FUNCTIONS.has(c.type) || CLASSES.has(c.type)) continue;
		if (c.type === "variable_declaration") declaratorNames(c, out);
		varNames(c, out);
	}
}

/** The names a node introduces for its own subtree (hoisting-level precision). */
function boundBy(node: Node): Set<string> {
	const out = new Set<string>();
	if (FUNCTIONS.has(node.type)) {
		for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) patternNames(p, out);
		patternNames(node.childForFieldName("parameter"), out);
		typeParameterNames(node, out);
		if (node.type === "function_expression" || node.type === "function" || node.type === "generator_function")
			patternNames(node.childForFieldName("name"), out);
		varNames(node, out);
	} else if (
		CLASSES.has(node.type) ||
		node.type === "interface_declaration" ||
		node.type === "type_alias_declaration"
	) {
		typeParameterNames(node, out);
		if (node.type === "class") patternNames(node.childForFieldName("name"), out);
	} else if (node.type === "statement_block") {
		for (const c of node.namedChildren) {
			if (c.type === "lexical_declaration") declaratorNames(c, out);
			else if (NAMED_DECLARATIONS.has(c.type)) patternNames(c.childForFieldName("name"), out);
		}
	} else if (node.type === "for_statement") {
		const init = node.childForFieldName("initializer");
		if (init?.type === "lexical_declaration") declaratorNames(init, out);
	} else if (node.type === "for_in_statement") {
		if (node.childForFieldName("kind")) patternNames(node.childForFieldName("left"), out);
	} else if (node.type === "catch_clause") {
		patternNames(node.childForFieldName("parameter"), out);
	}
	return out;
}

/** Nodes that may refer to an imported binding. Property names (`x.loadSettings`) are other node types. */
const USE_NODES = new Set(["identifier", "type_identifier", "shorthand_property_identifier"]);

/** Where uses of one imported binding are collected while walking. */
type Tracked = { lines: Set<number> } | { members: Map<string, Set<number>> };

function addLine(lines: Set<number>, at: number) {
	if (lines.size < MAX_USE_LINES) lines.add(at);
}

const sorted = (lines: Set<number>) => [...lines].sort((a, b) => a - b);

/** The member a use of a namespace binding names: `ns.Store` and `ns.Settings` (a type) give the name, else "*". */
function memberOf(node: Node): string {
	const p = node.parent;
	if (p?.type === "member_expression" && p.childForFieldName("object")?.startIndex === node.startIndex)
		return p.childForFieldName("property")?.text ?? "*";
	if (p?.type === "nested_type_identifier" && p.childForFieldName("module")?.startIndex === node.startIndex)
		return p.childForFieldName("name")?.text ?? "*";
	return "*";
}

/** The file's imports, with the lines where each imported binding is used, respecting the scopes that shadow it. */
function importsOf(path: string, root: Node): Import[] {
	const imports: Import[] = [];
	const tracked = new Map<string, Tracked>();
	const uses = new Map<ImportedName | NamespaceImport, Tracked>();
	for (const n of root.namedChildren) {
		if (n.type !== "import_statement") continue;
		const requireClause = n.namedChildren.find((c) => c.type === "import_require_clause");
		const from = stringValue((requireClause ?? n).childForFieldName("source"));
		if (from === null) continue;
		const target = relativeTarget(path, from);
		const imp: Import = target === null ? { from, names: [] } : { from, resolved: target, names: [] };
		const bindNamespace = (local: string) => {
			const ns: NamespaceImport = { local, uses: [] };
			const t: Tracked = { members: new Map() };
			imp.namespace = ns;
			tracked.set(local, t);
			uses.set(ns, t);
		};
		const bindName = (imported: string, local: string) => {
			const named: ImportedName = { imported, local, uses: [] };
			const t: Tracked = { lines: new Set() };
			imp.names.push(named);
			tracked.set(local, t);
			uses.set(named, t);
		};
		// TypeScript's `import x = require("./y")` binds the whole module, like a namespace.
		const required = requireClause?.namedChildren.find((c) => c.type === "identifier");
		if (required) bindNamespace(required.text);
		const clause = n.namedChildren.find((c) => c.type === "import_clause");
		for (const c of clause?.namedChildren ?? []) {
			if (c.type === "identifier") bindName("default", c.text);
			else if (c.type === "namespace_import") {
				const id = c.namedChildren.find((x) => x.type === "identifier");
				if (id) bindNamespace(id.text);
			} else if (c.type === "named_imports") {
				for (const s of c.namedChildren) {
					if (s.type !== "import_specifier") continue;
					const name = stringValue(s.childForFieldName("name"));
					if (name === null) continue;
					bindName(name, s.childForFieldName("alias")?.text ?? name);
				}
			}
		}
		imports.push(imp);
	}
	if (tracked.size > 0) collectUses(root, tracked);
	for (const [target, t] of uses) {
		if ("lines" in t) (target as ImportedName).uses = sorted(t.lines);
		else (target as NamespaceImport).uses = [...t.members].map(([name, lines]) => ({ name, lines: sorted(lines) }));
	}
	return imports;
}

/** Walks the tree once (iteratively: deep trees must not overflow the stack), noting each use of a tracked binding. */
function collectUses(root: Node, tracked: Map<string, Tracked>) {
	const stack: [Node, Map<string, Tracked>][] = [[root, tracked]];
	while (stack.length > 0) {
		const [node, inherited] = stack.pop()!;
		if (node.type === "import_statement") continue;
		let scope = inherited;
		for (const name of boundBy(node)) {
			if (!scope.has(name)) continue;
			if (scope === inherited) scope = new Map(inherited);
			scope.delete(name);
		}
		if (scope.size === 0) continue;
		if (USE_NODES.has(node.type)) {
			const t = scope.get(node.text);
			if (t && "lines" in t) addLine(t.lines, line(node));
			else if (t) {
				const member = memberOf(node);
				let lines = t.members.get(member);
				if (!lines) t.members.set(member, (lines = new Set()));
				addLine(lines, line(node));
			}
		}
		// Pushed last to first, so the walk goes in source order and the lines kept are the first ones.
		const children = node.namedChildren;
		for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, scope]);
	}
}
