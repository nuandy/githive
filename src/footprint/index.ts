// Footprints: what a TypeScript or JavaScript file declares, imports and uses, which exported names a change
// alters, and the notices that tell it (docs/awareness.md, section 7). Pure: it reads no git and no files, and
// parses in the Worker with web-tree-sitter.

export { newParseBatch, parserMemoryBytes } from "./engine";
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
export {
	FACTS_SAID,
	headsUpNext,
	headsUpSays,
	headsUpUsedNext,
	headsUpUsedSays,
	INTENT_SAID,
	interfaceNext,
	interfaceSays,
	SAYS_CHARS,
	useFact,
	useSays,
	whatChanged,
	type Landing,
	type OpenChange,
	type UseFact,
} from "./wording";
