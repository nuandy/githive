import { type FormEvent, useState } from "react";
import type { Gitignore, ManageApi, MyOrg, NewRepoInput, RepoRecord } from "../api";
import { usePoll } from "../hooks/usePoll";
import { creatableOwners, repoNameProblem } from "../lib/orgs";
import { href } from "../lib/routes";
import { messageOf } from "./Confirm";
import "./Manage.css";

type Source = "import" | "copy" | "empty";

export interface NewRepoViewProps {
	/** The caller's namespaces and orgs; undefined while loading. */
	orgs: MyOrg[] | undefined;
	/** Repos the caller can see, to copy from. */
	repos: { name: string }[] | undefined;
	/** An owner to start with (from #/new?owner=). */
	owner?: string;
	create: (input: NewRepoInput) => Promise<RepoRecord>;
	/** Where to go once it's made. */
	onCreated: (repo: RepoRecord) => void;
}

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

/** The request a filled-in form makes: only the fields its source needs. */
export function newRepoInput(form: { owner: string; name: string; source: Source; url: string; branch: string; copyFrom: string; visibility: "private" | "public"; first?: FirstCommit }): NewRepoInput {
	const base = { owner: form.owner, name: form.name.trim(), visibility: form.visibility };
	if (form.source === "import") return { ...base, import_url: form.url.trim(), ...(form.branch.trim() ? { branch: form.branch.trim() } : {}) };
	if (form.source === "copy") return { ...base, copy_from: form.copyFrom };
	const first = form.first ?? DEFAULT_FIRST_COMMIT;
	if (emptyFirstCommit(first)) return base;
	const description = first.readme ? first.description.trim() : "";
	return {
		...base,
		init: { ...(first.readme ? { readme: true } : {}), ...(description ? { description } : {}), ...(first.gitignore ? { gitignore: first.gitignore } : {}), ...(first.license ? { license: first.license } : {}) },
	};
}

/** A new repository, in your own namespace or an org you may create in: imported, copied, or empty. */
export function NewRepoView({ orgs, repos, owner: wanted, create, onCreated }: NewRepoViewProps) {
	const owners = orgs ? creatableOwners(orgs) : [];
	const [owner, setOwner] = useState<string | null>(null);
	const chosen = owner ?? (owners.find((o) => o.slug === wanted)?.slug ?? owners[0]?.slug ?? "");
	const [name, setName] = useState("");
	const [source, setSource] = useState<Source>("import");
	const [url, setUrl] = useState("");
	const [branch, setBranch] = useState("");
	const [copyFrom, setCopyFrom] = useState("");
	const [visibility, setVisibility] = useState<"private" | "public">("private");
	const [first, setFirst] = useState<FirstCommit>(DEFAULT_FIRST_COMMIT);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const nameProblem = name ? repoNameProblem(name.trim()) : null;
	const ready = !!chosen && !!name.trim() && !nameProblem && (source !== "import" || !!url.trim()) && (source !== "copy" || !!copyFrom);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready) return;
		setBusy(true);
		setError(null);
		try {
			onCreated(await create(newRepoInput({ owner: chosen, name, source, url, branch, copyFrom, visibility, first })));
		} catch (err) {
			setError(messageOf(err));
			setBusy(false);
		}
	};

	return (
		<main className="page manage" id="main">
			<header>
				<h1>New repository</h1>
				<p className="muted manage__lede">Agents work on it once GitHive is started on it, with the MCP start tool.</p>
			</header>
			{orgs === undefined ? (
				<p className="muted" role="status">
					Loading…
				</p>
			) : owners.length === 0 ? (
				<div className="box empty">
					<h2>You can't make repositories here</h2>
					<p>Ask an owner of an organization to let members make repositories, or make one under your own name.</p>
				</div>
			) : (
				<form className="box manage__form" onSubmit={submit}>
					<div className="box__body manage__form">
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
							<input id="new-repo-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} placeholder="my-project" aria-describedby="new-repo-name-hint" />
							<p className="manage__hint" id="new-repo-name-hint">
								{nameProblem ? <span className="error">{nameProblem}</span> : chosen && name.trim() ? `It will be ${chosen}/${name.trim()}.` : "Letters, digits, dots, underscores and dashes."}
							</p>
						</div>
						<fieldset className="manage__field manage__choices">
							<legend className="manage__label">Start from</legend>
							<label className="manage__choice">
								<input type="radio" name="new-repo-source" value="import" checked={source === "import"} onChange={() => setSource("import")} />
								<span>
									<strong>A Git repository</strong>
									<span className="muted">Imported from its URL, for example a public GitHub repository.</span>
								</span>
							</label>
							<label className="manage__choice">
								<input type="radio" name="new-repo-source" value="copy" checked={source === "copy"} onChange={() => setSource("copy")} />
								<span>
									<strong>A copy of a repository here</strong>
									<span className="muted">Its default branch, in seconds.</span>
								</span>
							</label>
							<label className="manage__choice">
								<input type="radio" name="new-repo-source" value="empty" checked={source === "empty"} onChange={() => setSource("empty")} />
								<span>
									<strong>Start fresh</strong>
									<span className="muted">A new repository with a first commit, ready for agents.</span>
								</span>
							</label>
						</fieldset>
						{source === "import" ? (
							<div className="manage__source">
								<div className="manage__field">
									<label htmlFor="new-repo-url">Git URL</label>
									<input id="new-repo-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/octocat/Spoon-Knife" autoComplete="off" spellCheck={false} />
								</div>
								<div className="manage__field manage__source-branch">
									<label htmlFor="new-repo-branch">Branch (optional)</label>
									<input id="new-repo-branch" type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
								</div>
							</div>
						) : source === "copy" ? (
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
						) : (
							<fieldset className="manage__field manage__first">
								<legend className="manage__label">First commit</legend>
								<label className="manage__check">
									<input type="checkbox" checked={first.readme} onChange={(e) => setFirst({ ...first, readme: e.target.checked })} />
									<span>Add a README</span>
								</label>
								{first.readme ? (
									<div className="manage__field">
										<label htmlFor="new-repo-description">Description (optional)</label>
										<input id="new-repo-description" type="text" value={first.description} onChange={(e) => setFirst({ ...first, description: e.target.value })} placeholder="Shown under the name in the README" maxLength={300} autoComplete="off" />
									</div>
								) : null}
								<div className="manage__inline">
									<div className="manage__field">
										<label htmlFor="new-repo-gitignore">.gitignore</label>
										<select id="new-repo-gitignore" value={first.gitignore} onChange={(e) => setFirst({ ...first, gitignore: e.target.value as FirstCommit["gitignore"] })}>
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
										<select id="new-repo-license" value={first.license} onChange={(e) => setFirst({ ...first, license: e.target.value as FirstCommit["license"] })}>
											<option value="">None</option>
											<option value="mit">MIT</option>
										</select>
									</div>
								</div>
								<p className="manage__hint">
									{emptyFirstCommit(first)
										? "With nothing in it, the repository has no branch: GitHive can't start on it, and agents can't work in it, until someone pushes a first commit."
										: "A .gitignore keeps build output and dependencies (node_modules, .venv, target) out of commits, and out of agents' claims."}
								</p>
							</fieldset>
						)}
						<fieldset className="manage__field manage__choices">
							<legend className="manage__label">Who can see it</legend>
							<label className="manage__choice">
								<input type="radio" name="new-repo-visibility" value="private" checked={visibility === "private"} onChange={() => setVisibility("private")} />
								<span>
									<strong>Private</strong>
									<span className="muted">Only the owner's members and the collaborators you add.</span>
								</span>
							</label>
							<label className="manage__choice">
								<input type="radio" name="new-repo-visibility" value="public" checked={visibility === "public"} onChange={() => setVisibility("public")} />
								<span>
									<strong>Public</strong>
									<span className="muted">Anyone signed in to GitHive can read it; only you choose who works in it.</span>
								</span>
							</label>
						</fieldset>
						{error ? (
							<p className="error" role="alert">
								{error}
							</p>
						) : null}
						<div className="manage__actions">
							<button type="submit" className="accent" disabled={!ready || busy}>
								{busy ? (source === "import" ? "Importing… (a big project takes a minute)" : "Making…") : "Make repository"}
							</button>
							<a className="button" href={href.repos()}>
								Cancel
							</a>
						</div>
					</div>
				</form>
			)}
		</main>
	);
}

/** The page, with its data. */
export function NewRepoPage({ manage, owner }: { manage: ManageApi; owner?: string }) {
	const orgs = usePoll("orgs", manage.orgs, 120_000);
	const repos = usePoll("repos:all", manage.repos, 120_000);
	return (
		<NewRepoView
			orgs={orgs.data ?? (orgs.error ? [] : undefined)}
			repos={repos.data}
			{...(owner ? { owner } : {})}
			create={manage.createRepo}
			onCreated={(repo) => {
				window.location.hash = href.repo(repo.fullName);
			}}
		/>
	);
}
