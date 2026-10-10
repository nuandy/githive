import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// D1, as much of it as GitHive uses, over Node's own SQLite, with the
// project's migrations applied: prepare, bind, first, all, run and batch.

type Value = string | number | null;

class Statement {
	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		private readonly values: Value[] = [],
	) {}

	bind(...values: unknown[]) {
		return new Statement(
			this.db,
			this.sql,
			values.map((v) => (v === undefined ? null : (v as Value))),
		);
	}

	async first<T>(column?: string): Promise<T | null> {
		const row = this.db.prepare(this.sql).get(...this.values) as Record<string, unknown> | undefined;
		if (!row) return null;
		return (column ? row[column] : { ...row }) as T;
	}

	async all<T>(): Promise<{ results: T[] }> {
		return {
			results: (this.db.prepare(this.sql).all(...this.values) as Record<string, unknown>[]).map((r) => ({ ...r }) as T),
		};
	}

	async run() {
		const result = this.db.prepare(this.sql).run(...this.values);
		return { success: true, meta: { changes: Number(result.changes) } };
	}

	runSync() {
		return this.db.prepare(this.sql).run(...this.values);
	}
}

/** A fresh in-memory database with every migration in migrations/ applied. */
export function fakeD1() {
	const db = new DatabaseSync(":memory:");
	const dir = join(import.meta.dirname, "..", "..", "migrations");
	for (const file of readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort())
		db.exec(readFileSync(join(dir, file), "utf8"));
	return {
		prepare: (sql: string) => new Statement(db, sql),
		/** All or nothing, as D1's batch is. */
		batch: async (statements: Statement[]) => {
			db.exec("BEGIN");
			try {
				const results = statements.map((s) => s.runSync());
				db.exec("COMMIT");
				return results;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		raw: db,
	} as unknown as D1Database & { raw: DatabaseSync };
}
