import type { LaneChangeCoordinator } from "./lane-change-contract";

export type ParkBuilderResult =
	| { outcome: "parked"; parkedAt: string; waitingFor: string[] }
	| { outcome: "refused"; reason: string; resolutions?: { requestId: string; status: string; message: string }[] };

export interface BuilderResumeCredentials {
	token: string;
	base: { remote: string; token: string };
}

export interface BuilderParkingAgent {
	park(parkedAt: string, waitingFor: string[]): Promise<void>;
	/**
	 * Deliver a stable Coordinator wake event exactly once. Implementations retain
	 * event IDs across restarts, enqueue the message if already working, and resume
	 * the parked conversation with fresh credentials if parked.
	 */
	wake(eventId: string, message: string, credentials: BuilderResumeCredentials): Promise<"resumed" | "deferred" | "ignored">;
	markParkTimedOut(): Promise<boolean>;
}

declare module "./lane-change-contract" {
	interface LaneChangeCoordinator {
		parkBuilder(sliceId: string): Promise<ParkBuilderResult>;
		parkedBuilderTimedOut(sliceId: string, parkedAt: string): Promise<void>;
	}
}

declare module "./types" {
	interface Slice {
		parkedAt?: string;
		parkedWaitingFor?: string[];
		/** Wake events not yet confirmed delivered, in order. An event leaves only after Builder.wake succeeds. */
		wakeOutbox?: { eventId: string; message: string }[];
		/** Wake events confirmed delivered, so a repeat is never sent twice. */
		wakeEventIds?: string[];
		/** The parkedAt whose 30-minute timeout has been flagged for a human, so it is flagged exactly once. */
		parkTimeoutFlagged?: string;
	}
}

declare module "./builder" {
	interface Builder {
		park(parkedAt: string, waitingFor: string[]): Promise<void>;
		wake(eventId: string, message: string, credentials: BuilderResumeCredentials): Promise<"resumed" | "deferred" | "ignored">;
		markParkTimedOut(): Promise<boolean>;
	}
}

export const BUILDER_PARK_TIMEOUT_MS = 30 * 60_000;
void (null as unknown as LaneChangeCoordinator | null);
