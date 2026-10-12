// Files the footprint tests change in different ways (from artifact-submission's reader and footprint tests).

/** A TypeScript file with an interface, a function, a class with a private field, and a function with no return type. */
export const SETTINGS = [
	"export interface Settings { timeout: number }",
	"",
	"export function loadSettings(path: string): Settings {",
	"  return { timeout: path.length };",
	"}",
	"",
	"export class Store {",
	"  get(key: string): string {",
	"    return key;",
	"  }",
	"  private cache = new Map<string, string>();",
	"}",
	"",
	"export function total(xs: number[]) {",
	"  return xs.length;",
	"}",
	"",
].join("\n");

/** The settings file of docs/awareness.md's example. */
export const SETTINGS_TS = [
	"export interface Settings { timeout: number }",
	"",
	"export function loadSettings(path: string): Settings {",
	"  return { timeout: path.length };",
	"}",
	"",
].join("\n");

/** SETTINGS_TS with loadSettings returning Result<Settings>: an interface change. */
export const SIGNATURE_CHANGE = SETTINGS_TS.replace(
	"export function loadSettings(path: string): Settings {",
	"export function loadSettings(path: string): Result<Settings> {",
);

/** src/jobs/sync.ts calling loadSettings on line 4. */
export const USES_LOAD = [
	'import { loadSettings } from "../config";',
	"",
	"export function sync() {",
	'  return loadSettings("x");',
	"}",
	"",
].join("\n");
