/**
 * Where a request's time goes, for a Server-Timing header: each step's
 * duration, by name. Steps run in parallel are timed separately.
 */
export class Timing {
	private readonly steps: [string, number][] = [];

	async time<T>(name: string, step: () => Promise<T>): Promise<T> {
		const start = Date.now();
		try {
			return await step();
		} finally {
			this.steps.push([name, Date.now() - start]);
		}
	}

	header() {
		return this.steps.map(([name, ms]) => `${name};dur=${ms}`).join(", ");
	}
}
