import type { ReactNode } from "react";
import type { Gitignore, MyOrg } from "../api";

export type Source = "import" | "copy" | "empty";

/** What a fresh repo's first commit holds. */
export interface FirstCommit {
	readme: boolean;
	description: string;
	gitignore: Gitignore | "";
	license: "mit" | "";
}
export const DEFAULT_FIRST_COMMIT: FirstCommit = { readme: true, description: "", gitignore: "", license: "" };
const GITIGNORES: { value: Gitignore; label: string }[] = [
	{ value: "node", label: "Node" },
	{ value: "python", label: "Python" },
	{ value: "go", label: "Go" },
	{ value: "rust", label: "Rust" },
];

/** Whether a fresh repo would start with no commit (and so no branch for agents to work from). */
export const emptyFirstCommit = (first: FirstCommit) => !first.readme && !first.gitignore && !first.license;

/** The page around the form, or around what shows instead of it. */
export function NewRepoFrame({ children }: { children: ReactNode }) {
	return (
		<main className="page manage" id="main">
			<header>
				<h1>New repository</h1>
				<p className="muted manage__lede">
					GitHive starts on it as it's made, so agents can claim work in it at once. Its review policy and checks are in
					its Settings.
				</p>
			</header>
			{children}
		</main>
	);
}

/** Who owns the new repository, and its name, with a hint for the name. */
export function OwnerAndName(props: {
	owners: MyOrg[];
	chosen: string;
	setOwner: (owner: string) => void;
	name: string;
	setName: (name: string) => void;
	hint: ReactNode;
}) {
	const { owners, chosen, setOwner, name, setName, hint } = props;
	return (
		<>
			<div className="manage__field">
				<label htmlFor="new-repo-owner">Owner</label>
				<select id="new-repo-owner" value={chosen} onChange={(e) => setOwner(e.target.value)}>
					{owners.map((o) => (
						<option key={o.slug} value={o.slug}>
							{o.personal ? `${o.slug} (you)` : o.slug}
						</option>
					))}
				</select>
			</div>
			<div className="manage__field">
				<label htmlFor="new-repo-name">Name</label>
				<input
					id="new-repo-name"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					autoComplete="off"
					spellCheck={false}
					placeholder="my-project"
					aria-describedby="new-repo-name-hint"
				/>
				<p className="manage__hint" id="new-repo-name-hint">
					{hint}
				</p>
			</div>
		</>
	);
}

export type Choice<T> = { value: T; title: string; detail: string };

export const SOURCES: Choice<Source>[] = [
	{
		value: "import",
		title: "A Git repository",
		detail: "Imported from its URL, for example a public GitHub repository.",
	},
	{ value: "copy", title: "A copy of a repository here", detail: "Its default branch, in seconds." },
	{ value: "empty", title: "Start fresh", detail: "A new repository with a first commit, ready for agents." },
];

export const VISIBILITIES: Choice<"private" | "public">[] = [
	{ value: "private", title: "Private", detail: "Only the owner's members and the collaborators you add." },
	{
		value: "public",
		title: "Public",
		detail: "Anyone signed in to GitHive can read it; only you choose who works in it.",
	},
];

/** One choice from a few, each a radio button with a line saying what it means. */
export function RadioChoices<T extends string>(props: {
	legend: string;
	name: string;
	value: T;
	onChange: (value: T) => void;
	options: Choice<T>[];
}) {
	const { legend, name, value, onChange, options } = props;
	return (
		<fieldset className="manage__field manage__choices">
			<legend className="manage__label">{legend}</legend>
			{options.map((option) => (
				<label key={option.value} className="manage__choice">
					<input
						type="radio"
						name={name}
						value={option.value}
						checked={value === option.value}
						onChange={() => onChange(option.value)}
					/>
					<span>
						<strong>{option.title}</strong>
						<span className="muted">{option.detail}</span>
					</span>
				</label>
			))}
		</fieldset>
	);
}

/** Where to import from: a Git URL and, optionally, its branch. */
export function ImportSource(props: {
	url: string;
	setUrl: (url: string) => void;
	branch: string;
	setBranch: (branch: string) => void;
	token: string;
	setToken: (token: string) => void;
}) {
	const { url, setUrl, branch, setBranch, token, setToken } = props;
	return (
		<div className="manage__source">
			<div className="manage__field">
				<label htmlFor="new-repo-url">Git URL</label>
				<input
					id="new-repo-url"
					type="url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://github.com/octocat/Spoon-Knife"
					autoComplete="off"
					spellCheck={false}
				/>
			</div>
			<div className="manage__field manage__source-branch">
				<label htmlFor="new-repo-branch">Branch (optional)</label>
				<input
					id="new-repo-branch"
					type="text"
					value={branch}
					onChange={(e) => setBranch(e.target.value)}
					placeholder="main"
					autoComplete="off"
					spellCheck={false}
				/>
			</div>
			<div className="manage__field manage__source-token">
				<label htmlFor="new-repo-token">Access token, for a private repo (optional)</label>
				<input
					id="new-repo-token"
					type="password"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="github_pat_…"
					autoComplete="off"
					spellCheck={false}
					aria-describedby="new-repo-token-hint"
				/>
				<p className="manage__hint" id="new-repo-token-hint">
					On GitHub, make a{" "}
					<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
						fine-grained token
					</a>{" "}
					with read-only access to this repository's contents. GitHive uses it once to clone the repository, and keeps
					it nowhere.
				</p>
			</div>
		</div>
	);
}

/** Which repository here to copy. */
export function CopySource(props: {
	repos: { name: string }[] | undefined;
	copyFrom: string;
	setCopyFrom: (name: string) => void;
}) {
	const { repos, copyFrom, setCopyFrom } = props;
	return (
		<div className="manage__field">
			<label htmlFor="new-repo-copy">Repository to copy</label>
			<select id="new-repo-copy" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
				<option value="">Choose one…</option>
				{(repos ?? []).map((r) => (
					<option key={r.name} value={r.name}>
						{r.name}
					</option>
				))}
			</select>
		</div>
	);
}

/** What a fresh repository's first commit holds. */
export function FirstCommitFields({ first, setFirst }: { first: FirstCommit; setFirst: (first: FirstCommit) => void }) {
	return (
		<fieldset className="manage__field manage__first">
			<legend className="manage__label">First commit</legend>
			<label className="manage__check">
				<input
					type="checkbox"
					checked={first.readme}
					onChange={(e) => setFirst({ ...first, readme: e.target.checked })}
				/>
				<span>Add a README</span>
			</label>
			{first.readme ? (
				<div className="manage__field">
					<label htmlFor="new-repo-description">Description (optional)</label>
					<input
						id="new-repo-description"
						type="text"
						value={first.description}
						onChange={(e) => setFirst({ ...first, description: e.target.value })}
						placeholder="Shown under the name in the README"
						maxLength={300}
						autoComplete="off"
					/>
				</div>
			) : null}
			<div className="manage__inline">
				<div className="manage__field">
					<label htmlFor="new-repo-gitignore">.gitignore</label>
					<select
						id="new-repo-gitignore"
						value={first.gitignore}
						onChange={(e) => setFirst({ ...first, gitignore: e.target.value as FirstCommit["gitignore"] })}
					>
						<option value="">None</option>
						{GITIGNORES.map((g) => (
							<option key={g.value} value={g.value}>
								{g.label}
							</option>
						))}
					</select>
				</div>
				<div className="manage__field">
					<label htmlFor="new-repo-license">License</label>
					<select
						id="new-repo-license"
						value={first.license}
						onChange={(e) => setFirst({ ...first, license: e.target.value as FirstCommit["license"] })}
					>
						<option value="">None</option>
						<option value="mit">MIT</option>
					</select>
				</div>
			</div>
			<p className="manage__hint">
				{emptyFirstCommit(first)
					? "With nothing in it, the repository has no branch: GitHive can't " +
						"start on it, and agents can't work in it, until someone pushes a " +
						"first commit."
					: "A .gitignore keeps build output and dependencies (node_modules, " +
						".venv, target) out of commits, and out of agents' claims."}
			</p>
		</fieldset>
	);
}
