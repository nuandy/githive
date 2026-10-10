// When the repo's own Gate saves its container as the repo's snapshot, and how long a saved one stays usable.
import type { SetupSnapshot } from "./container";
import { statusOf } from "./errors";

/** Retaking a snapshot weekly keeps fetches from it small and keeps it within Containers' 30-day retention. */
const SNAPSHOT_RETAKE_MS = 7 * 24 * 3600_000;
/** Containers keeps a snapshot 30 days after it was taken or last restored, so an older one may be gone. */
const SNAPSHOT_USABLE_MS = 25 * 24 * 3600_000;

/** A new snapshot is due when there is none, when its dependencies differ from the installed ones, or after a week. */
export function snapshotDue(
	current: SetupSnapshot | null,
	installed: { lockHash?: string; depsHash?: string },
	now = Date.now(),
) {
	return (
		!current ||
		current.lockHash !== installed.lockHash ||
		current.depsHash !== installed.depsHash ||
		now - current.at >= SNAPSHOT_RETAKE_MS
	);
}

/** Whether a saved snapshot is recent enough that Containers still keeps it. */
export function snapshotUsable(snapshot: SetupSnapshot) {
	return Date.now() - snapshot.at < SNAPSHOT_USABLE_MS;
}

/** Saves the container's disk as the repo's snapshot, recording what its dependencies were installed from. */
async function takeSnapshot(
	container: Container,
	repo: string,
	installed: { lockHash?: string; depsHash?: string },
): Promise<SetupSnapshot> {
	const { lockHash, depsHash } = installed;
	const taken = await container.snapshotContainer({ name: `githive-${repo}`.slice(0, 64) });
	return {
		id: taken.id,
		size: taken.size,
		at: Date.now(),
		...(lockHash ? { lockHash } : {}),
		...(depsHash ? { depsHash } : {}),
	};
}

/**
 * Saves the container as the repo's snapshot when one is due. A snapshot is only a head start, so a failure is just
 * logged.
 */
export async function saveSnapshotIfDue(container: Container, storage: DurableObjectStorage, repo: string) {
	const [current, lockHash, depsHash] = await Promise.all([
		storage.get<SetupSnapshot>("snapshot"),
		storage.get<string>("lockHash"),
		storage.get<string>("depsHash"),
	]);
	if (!snapshotDue(current ?? null, { lockHash, depsHash })) return;
	try {
		const started = Date.now();
		const taken = await takeSnapshot(container, repo, { lockHash, depsHash });
		await storage.put("snapshot", taken);
		console.log(`saved ${repo}'s snapshot (${Math.round(taken.size / 1e6)} MB) in ${Date.now() - started} ms`);
	} catch (err) {
		console.error(`saving ${repo}'s snapshot failed`, statusOf(err).message);
	}
}
