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
	wake(message: string, credentials: BuilderResumeCredentials): Promise<"resumed" | "deferred" | "ignored">;
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
		wakeMessage?: string;
		wakeEventIds?: string[];
	}
}

declare module "./builder" {
	interface Builder {
		park(parkedAt: string, waitingFor: string[]): Promise<void>;
		wake(message: string, credentials: BuilderResumeCredentials): Promise<"resumed" | "deferred" | "ignored">;
		markParkTimedOut(): Promise<boolean>;
	}
}

export const BUILDER_PARK_TIMEOUT_MS = 30 * 60_000;
void (null as unknown as LaneChangeCoordinator | null);
