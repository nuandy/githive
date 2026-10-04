export type ParkBuilderResult =
	| { outcome: "parked"; parkedAt: string; waitingFor: string[] }
	| { outcome: "refused"; reason: string; resolutions?: { requestId: string; status: string; message: string }[] };

export interface BuilderResumeCredentials {
	token: string;
	base: { remote: string; token: string };
}

export const BUILDER_PARK_TIMEOUT_MS = 30 * 60_000;
