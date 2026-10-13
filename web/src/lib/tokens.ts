// The review policy's lists as tokens: the roles that can block a change, and who may vote as each. The form keeps
// them as the text it always had ("security, api-design"), and the settings tool gets the same strings; a token input
// only chooses them. Who may vote is written in the settings tool's words: an agent's name, "person:*" (people
// themselves), "githive" (GitHive's reviewers), a team "@org/team", or an identity or pool ("service:<id>/*").

/** A role's name: lowercase words joined by hyphens, like "security" or "api-design". */
export const ROLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** People themselves, not their agents. */
export const ANY_PERSON = "person:*";
/** GitHive's own reviewers for the role. */
export const GITHIVE_REVIEWERS = "githive";

/** A choice offered as one types: the value saved, the words shown, and a line about it. */
export interface TokenOption {
	value: string;
	label: string;
	detail?: string;
}

/** The tokens in a list's text: split at commas and lines, trimmed, without blanks or repeats. */
export function tokensOf(text: string): string[] {
	return [
		...new Set(
			text
				.split(/[\n,]/)
				.map((token) => token.trim())
				.filter(Boolean),
		),
	];
}

/** The text the form keeps for a list of tokens. */
export const textOf = (tokens: string[]) => tokens.join(", ");

/** The tokens with what was typed added (split at commas), each as the value its words stand for, without repeats. */
export function addTyped(tokens: string[], typed: string, resolve: (typed: string) => string = (text) => text) {
	return [...new Set([...tokens, ...tokensOf(typed).map(resolve)])];
}

const PRESETS: TokenOption[] = [
	{ value: ANY_PERSON, label: "Any person", detail: "People themselves, from the dashboard, not their agents" },
	{ value: GITHIVE_REVIEWERS, label: "GitHive's reviewers", detail: "GitHive's own reviewer for the role" },
];

/** A holder in words: the presets by name, a pool by whose agents it is, anything else as it's written. */
export function holderLabel(value: string): string {
	const preset = PRESETS.find((option) => option.value === value);
	if (preset) return preset.label;
	if (value.endsWith("/*")) return `Any agent under ${value.slice(0, -2)}`;
	return value;
}

/** What a typed holder saves as: a preset's words stand for its value. */
export function resolveHolder(typed: string): string {
	const text = typed.trim();
	const preset = PRESETS.find((option) => option.label.toLowerCase() === text.toLowerCase());
	return preset ? preset.value : text;
}

/** Who may vote as a role, to choose from: the presets, the org's teams, and the reader's agents still active. */
export function holderOptions({
	teams,
	org,
	agents,
}: {
	teams: { slug: string; name: string | null }[];
	org: string;
	agents: { name: string; revoked?: boolean }[];
}): TokenOption[] {
	return [
		...PRESETS,
		...teams.map((team) => ({
			value: `@${org}/${team.slug}`,
			label: `@${org}/${team.slug}`,
			detail: team.name ? `Team: ${team.name}` : "Team",
		})),
		...agents
			.filter((agent) => !agent.revoked)
			.map((agent) => ({ value: agent.name, label: agent.name, detail: "Your agent" })),
	];
}

/** Roles to choose from: those the repo already uses, then the names of the org's teams, each once. */
export function roleOptions(used: string[], teams: { slug: string; name: string | null }[], org = ""): TokenOption[] {
	const options: TokenOption[] = used.map((role) => ({ value: role, label: role, detail: "Used in this repo" }));
	for (const team of teams)
		if (!options.some((option) => option.value === team.slug))
			options.push({ value: team.slug, label: team.slug, detail: `Named after the team @${org}/${team.slug}` });
	return options.filter((option) => ROLE.test(option.value));
}

/** The options that match what's typed, by their words or value, leaving out those chosen: what starts with it first. */
export function suggest(options: TokenOption[], typed: string, chosen: string[]): TokenOption[] {
	const query = typed.trim().toLowerCase();
	const open = options.filter((option) => !chosen.includes(option.value));
	if (!query) return open;
	const text = (option: TokenOption) => [option.label.toLowerCase(), option.value.toLowerCase()];
	const starts = open.filter((option) => text(option).some((words) => words.startsWith(query)));
	const within = open.filter(
		(option) => !starts.includes(option) && text(option).some((words) => words.includes(query)),
	);
	return [...starts, ...within];
}

/** What's wrong with a role's name, saying how to fix it; null for a good one. */
export function roleProblem(role: string): string | null {
	return ROLE.test(role)
		? null
		: `"${role}" isn't a role name: use lowercase words joined by hyphens, like "security" or "api-design".`;
}
