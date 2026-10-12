// The names GitHive's hosted agents take in a repo's hive: jobs in a beehive, each prefixed githive- as all of
// GitHive's own agents are. A hosted agent runs the loop any agent does (see hosted-agents.ts) and votes under its own
// name and identity, so the "githive" grant counts it as one of GitHive's reviewers.

/** The jobs hive agents are named for, in the order a repo's agents take them. */
export const HIVE_JOBS = [
	"forager",
	"scout",
	"nurse",
	"guard",
	"waggle",
	"drone",
	"fanner",
	"keeper",
	"comber",
	"cleaner",
	"heater",
	"carrier",
	"attendant",
] as const;

/** The most hosted agents a repo may run at once. */
export const MOST_HIVE_AGENTS = HIVE_JOBS.length;

/** The names of a repo's first `count` hosted agents. */
export const hiveAgentNames = (count: number) => HIVE_JOBS.slice(0, count).map((job) => `githive-${job}`);

const NAMES = new Set(hiveAgentNames(MOST_HIVE_AGENTS));

/** Whether `name` is a hive agent's. */
export const isHiveAgent = (name: string) => NAMES.has(name);

/** The identity a hive agent's records are stamped with. */
export const hiveIdentity = (name: string) => `service:${name}`;

/** Whether a stamp's identity is a hive agent's. */
export function isHiveIdentity(by: string) {
	if (!by.startsWith("service:")) return false;
	return isHiveAgent(by.slice("service:".length));
}
