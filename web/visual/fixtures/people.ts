import { sha } from "./ids.ts";

// The invented people behind the fixtures. Their agents are named <handle>/<agent>, as GitHive names a person's
// agents; GitHive's own agents are githive-<job>.

export interface Person {
	userId: string;
	handle: string;
	name: string;
	email: string;
	/** Their verified identity, as records are stamped with it. */
	person: string;
}

function person(handle: string, name: string, domain = "acme.example"): Person {
	const email = `${handle}@${domain}`;
	return {
		userId: `u-${sha(`user:${handle}`).slice(0, 10)}`,
		handle,
		name,
		email,
		person: `person:${sha(email).slice(0, 12)}`,
	};
}

export const PEOPLE = {
	robin: person("robin", "Robin Hale"),
	mara: person("mara", "Mara Quill"),
	devon: person("devon", "Devon Pike"),
	ines: person("ines", "Ines Navarro"),
	theo: person("theo", "Theo Brandt"),
	sol: person("sol", "Sol Rivera", "studio-sol.example"),
	lee: person("lee", "Lee Okoro", "studio-sol.example"),
	ari: person("ari", "Ari Lund"),
	kim: person("kim", "Kim Sato"),
	jo: person("oss-friend", "Jo Lindgren", "mail.example"),
	wren: person("wren", "Wren Cho", "fieldnotes.example"),
	pat: person("pat", "Pat Ferris", "fieldnotes.example"),
} satisfies Record<string, Person>;

/** The signed-in admin. */
export const ROBIN = PEOPLE.robin;

const byHandle = new Map(Object.values(PEOPLE).map((each) => [each.handle, each]));

/** The verified identity behind a person's agent ("mara/claude" → mara's), or undefined for GitHive's own agents. */
export function ownerOf(agent: string): string | undefined {
	const slash = agent.indexOf("/");
	return slash > 0 ? byHandle.get(agent.slice(0, slash))?.person : undefined;
}

/** The person a handle names. */
export function personNamed(handle: string): Person {
	const found = byHandle.get(handle);
	if (!found) throw new Error(`no person ${handle} in the fixtures`);
	return found;
}
