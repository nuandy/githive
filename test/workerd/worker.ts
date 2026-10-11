import { alteredNames, fileFacts } from "../../src/footprint";

// The workerd tests' Worker: compares two versions of a file posted as JSON, as the push consumer will.
export default {
	async fetch(request: Request): Promise<Response> {
		const { path, before, after } = await request.json<{ path: string; before: string; after: string }>();
		const [old, now] = await Promise.all([fileFacts(path, before), fileFacts(path, after)]);
		return Response.json({ before: old, after: now, altered: alteredNames(old, now) });
	},
};
