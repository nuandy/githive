// In-memory filesystem for isomorphic-git, adapted from the Artifacts docs:
// https://developers.cloudflare.com/artifacts/examples/isomorphic-git/
// Changes: errors carry a Node-style `code` (isomorphic-git checks for ENOENT),
// and readlink/symlink exist because isomorphic-git >= 1.3x binds them eagerly.

function fsError(code: string, path: string) {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

type Entry =
	| {
			kind: "dir";
			children: Set<string>;
			mtimeMs: number;
	  }
	| {
			kind: "file";
			data: Uint8Array;
			mtimeMs: number;
			executable?: boolean;
	  };

class MemoryStats {
	entry: Entry;
	/** isomorphic-git sets a checked-out file's mode from its tree before it indexes the file, so mode is writable. */
	private given?: number;

	constructor(entry: Entry) {
		this.entry = entry;
	}

	get size() {
		return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
	}

	get mtimeMs() {
		return this.entry.mtimeMs;
	}

	get ctimeMs() {
		return this.entry.mtimeMs;
	}

	get mode() {
		if (this.given !== undefined) return this.given;
		if (this.entry.kind === "dir") return 0o040000;
		return this.entry.executable ? 0o100755 : 0o100644;
	}

	set mode(mode: number) {
		this.given = mode;
	}

	isFile() {
		return this.entry.kind === "file";
	}

	isDirectory() {
		return this.entry.kind === "dir";
	}

	isSymbolicLink() {
		return false;
	}
}

export class MemoryFS {
	encoder = new TextEncoder();
	decoder = new TextDecoder();
	entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);

	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.lstat.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
	};

	normalize(input: string) {
		const segments: string[] = [];

		for (const part of input.split("/")) {
			if (!part || part === ".") {
				continue;
			}

			if (part === "..") {
				segments.pop();
				continue;
			}

			segments.push(part);
		}

		return `/${segments.join("/")}` || "/";
	}

	parent(path: string) {
		const normalized = this.normalize(path);
		if (normalized === "/") {
			return "/";
		}

		const parts = normalized.split("/").filter(Boolean);
		parts.pop();
		return parts.length ? `/${parts.join("/")}` : "/";
	}

	basename(path: string) {
		return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
	}

	getEntry(path: string) {
		return this.entries.get(this.normalize(path));
	}

	requireEntry(path: string) {
		const entry = this.getEntry(path);
		if (!entry) {
			throw fsError("ENOENT", path);
		}

		return entry;
	}

	requireDir(path: string) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "dir") {
			throw fsError("ENOTDIR", path);
		}

		return entry;
	}

	async mkdir(path: string, options?: { recursive?: boolean } | number) {
		const target = this.normalize(path);
		if (target === "/") {
			return;
		}

		const recursive = typeof options === "object" && options !== null && options.recursive;
		const parent = this.parent(target);

		if (!this.entries.has(parent)) {
			if (!recursive) {
				throw fsError("ENOENT", parent);
			}

			await this.mkdir(parent, { recursive: true });
		}

		if (this.entries.has(target)) {
			return;
		}

		this.entries.set(target, {
			kind: "dir",
			children: new Set(),
			mtimeMs: Date.now(),
		});

		this.requireDir(parent).children.add(this.basename(target));
	}

	async writeFile(
		path: string,
		data: string | Uint8Array | ArrayBuffer,
		options?: string | { mode?: number; encoding?: string },
	) {
		const target = this.normalize(path);
		await this.mkdir(this.parent(target), { recursive: true });
		// isomorphic-git writes an executable file with mode 0o777, and only that says it's executable.
		const mode = typeof options === "object" ? options.mode : undefined;
		const executable = mode !== undefined && (mode & 0o111) !== 0;

		this.entries.set(target, {
			kind: "file",
			data: this.toBytes(data),
			mtimeMs: Date.now(),
			...(executable ? { executable } : {}),
		});

		this.requireDir(this.parent(target)).children.add(this.basename(target));
	}

	toBytes(data: string | Uint8Array | ArrayBuffer) {
		if (typeof data === "string") return this.encoder.encode(data);
		return data instanceof Uint8Array ? data : new Uint8Array(data);
	}

	async readFile(path: string, options?: string | { encoding?: string }) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "file") {
			throw fsError("EISDIR", path);
		}

		const encoding = typeof options === "string" ? options : options?.encoding;
		return encoding ? this.decoder.decode(entry.data) : entry.data;
	}

	async readdir(path: string) {
		return [...this.requireDir(path).children].sort();
	}

	async unlink(path: string) {
		const target = this.normalize(path);
		const entry = this.requireEntry(target);
		if (entry.kind !== "file") {
			throw fsError("EISDIR", path);
		}

		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async rmdir(path: string) {
		const target = this.normalize(path);
		const entry = this.requireDir(target);
		if (entry.children.size > 0) {
			throw fsError("ENOTEMPTY", path);
		}

		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	/**
	 * An independent copy. Writes replace a file's bytes rather than change
	 * them, so the copy shares them; only directories' listings are copied.
	 */
	copy() {
		const copy = new MemoryFS();
		copy.entries = new Map(
			[...this.entries].map(([path, entry]) => [
				path,
				entry.kind === "dir" ? { ...entry, children: new Set(entry.children) } : entry,
			]),
		);
		return copy;
	}

	async stat(path: string) {
		return new MemoryStats(this.requireEntry(path));
	}

	async lstat(path: string) {
		return this.stat(path);
	}

	// Symlinks are never created (lstat reports none), so these only fail loudly.
	async readlink(path: string): Promise<string> {
		throw fsError("EINVAL", path);
	}

	async symlink(_target: string, path: string): Promise<void> {
		throw fsError("ENOSYS", `symlinks are not supported in memory: ${path}`);
	}
}
