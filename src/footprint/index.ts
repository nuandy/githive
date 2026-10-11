// Footprints: what a TypeScript or JavaScript file declares, imports and uses, and which exported names a change
// alters (docs/awareness.md, section 7). Pure: it reads no git and no files, and parses in the Worker with
// web-tree-sitter.

export {
	fileFacts,
	languageOf,
	MAX_PARSE_CHARS,
	MAX_USE_LINES,
	type Declaration,
	type DeclarationKind,
	type FileFacts,
	type Import,
	type ImportedName,
	type NamespaceImport,
} from "./extract";
export {
	alteredNames,
	importedName,
	NO_FILE,
	usesOf,
	usesOfAltered,
	type AlteredName,
	type Change,
	type Use,
} from "./compare";
export { importTargets, isRelative, relativeTarget, resolveImport, resolvesTo } from "./resolve";
