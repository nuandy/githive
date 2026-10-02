// RPC contract between the Coordinator (which handles send-back) and the task Gate.
// A group item containing this exact member commit is cancelled as a whole.
declare module "./gate" {
	interface Gate {
		cancel(taskId: string, slice: string, head: string): Promise<void>;
	}
}

export {};
