import { githive } from "../src/githive";
import { demoRepoOf } from "./demo/demo-repo";
import { houseModel } from "./house";
import { demoRoutes } from "./routes/demo";
import { usageRoutes } from "./routes/usage";

// githive.app: GitHive, with the Honeycomb demo runs, the Usage page's numbers and the house model added.

export {
	Builder,
	ChangeCache,
	FeedShard,
	FootprintCache,
	Gate,
	GitHubSync,
	HostedAgent,
	RecordCache,
	RepoCache,
	RepoIndex,
	Reviewer,
	TokenCache,
} from "../src/durable-objects";
export { DemoRun } from "./demo/demo-run";

export default githive({
	routes: [demoRoutes, usageRoutes],
	// Demo runs answer visitors too: watching is public, and starting one checks for itself (see routes/demo.ts).
	publicPrefixes: ["/demo/runs"],
	apiRoutes: ["GET  /usage?range=24h|7d   (what your own repos used on Cloudflare, and its cost at list prices)"],
	houseModel,
	// A public repo anyone may read signed out, where GitHive's own agents work: the sign-in card links to it.
	signInExtras: (env) => {
		const demoRepo = demoRepoOf(env);
		return demoRepo ? { demoRepo } : {};
	},
});
