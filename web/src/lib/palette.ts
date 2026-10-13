import { href } from "./routes";

// The ⌘K palette's places: the open changes in the repo shown, the reader's repos, and the dashboard's pages; found
// by what's typed.

export interface PaletteItem {
	id: string;
	kind: "change" | "repo" | "page";
	label: string;
	/** What else it's found by, said beside it: a change's id. */
	detail?: string;
	href: string;
}

/** The places, in the order they show before anything's typed. */
export function paletteItems({
	repos,
	repo,
	changes = [],
	people,
}: {
	/** The reader's repos, most recently active first. */
	repos: string[];
	/** The repo shown, if any, and its open changes. */
	repo?: string;
	changes?: { change: string; title: string }[];
	/** A person signed in, who has agents, organizations and new repositories of their own. */
	people: boolean;
}): PaletteItem[] {
	const pages: PaletteItem[] = [
		{ id: "page:inbox", kind: "page", label: "Inbox", href: href.inbox() },
		{ id: "page:repos", kind: "page", label: "Repositories", href: href.repos() },
	];
	if (people)
		pages.push(
			{ id: "page:agents", kind: "page", label: "Your agents", href: href.agents() },
			{ id: "page:orgs", kind: "page", label: "Your organizations", href: href.orgs() },
			{ id: "page:new", kind: "page", label: "New repository", href: href.newRepo() },
		);
	return [
		...(repo
			? changes.map((each): PaletteItem => ({
					id: `change:${each.change}`,
					kind: "change",
					label: each.title || each.change,
					detail: each.change,
					href: href.change(repo, each.change),
				}))
			: []),
		...repos.map((name): PaletteItem => ({ id: `repo:${name}`, kind: "repo", label: name, href: href.repo(name) })),
		...pages,
	];
}

/**
 * How well an item answers `query`, lower first: its name starts with it, a word in its name does, its name has it,
 * what's said beside it has it; or, for several words, each is somewhere in it. Null when it doesn't answer.
 */
function score(item: PaletteItem, query: string, words: string[]): number | null {
	const label = item.label.toLowerCase();
	const detail = (item.detail ?? "").toLowerCase();
	if (label.startsWith(query)) return 0;
	if (label.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query))) return 1;
	if (label.includes(query)) return 2;
	if (detail.includes(query)) return 3;
	const all = `${label} ${detail}`;
	return words.length > 1 && words.every((word) => all.includes(word)) ? 4 : null;
}

/** Before anything's typed, how many of each kind show, so a busy repo's changes leave room for the rest. */
export const FIRST_OF_EACH = 5;

/**
 * The items that answer what's typed, best first, then in their own order; before anything's typed, the first few
 * of each kind.
 */
export function filterPalette(items: PaletteItem[], typed: string, limit = 50): PaletteItem[] {
	const query = typed.trim().toLowerCase().replace(/\s+/g, " ");
	if (!query) {
		const seen = new Map<PaletteItem["kind"], number>();
		return items
			.filter((item) => {
				const count = (seen.get(item.kind) ?? 0) + 1;
				seen.set(item.kind, count);
				return count <= FIRST_OF_EACH;
			})
			.slice(0, limit);
	}
	const words = query.split(" ");
	return items
		.flatMap((item, index) => {
			const rank = score(item, query, words);
			return rank === null ? [] : [{ item, rank, index }];
		})
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.slice(0, limit)
		.map(({ item }) => item);
}
