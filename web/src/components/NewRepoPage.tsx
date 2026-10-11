import { type FormEvent, type ReactNode, useState } from "react";
import type { ManageApi, MyOrg, NewRepoInput, RepoRecord } from "../api";
import { usePoll } from "../hooks/usePoll";
import { creatableOwners, repoNameProblem } from "../lib/orgs";
import { href } from "../lib/routes";
import { messageOf } from "../lib/errors";
import {
	CopySource,
	DEFAULT_FIRST_COMMIT,
	emptyFirstCommit,
	type FirstCommit,
	FirstCommitFields,
	ImportSource,
	NewRepoFrame,
	OwnerAndName,
	RadioChoices,
	type Source,
	SOURCES,
	VISIBILITIES,
} from "./NewRepoFields";
import "./Manage.css";

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

/** The request a filled-in form makes: only the fields its source needs. */
export function newRepoInput(form: {
	owner: string;
	name: string;
	source: Source;
	url: string;
	branch: string;
	/** A token that reads a private repo, for an import. */
	token?: string;
	copyFrom: string;
	visibility: "private" | "public";
	first?: FirstCommit;
}): NewRepoInput {
	const base = { owner: form.owner, name: form.name.trim(), visibility: form.visibility };
	if (form.source === "import") {
		const branch = form.branch.trim();
		const token = form.token?.trim() ?? "";
		return {
			...base,
			import_url: form.url.trim(),
			...(branch ? { branch } : {}),
			...(token ? { import_token: token } : {}),
		};
	}
	if (form.source === "copy") return { ...base, copy_from: form.copyFrom };
	const first = form.first ?? DEFAULT_FIRST_COMMIT;
	if (emptyFirstCommit(first)) return base;
	const description = first.readme ? first.description.trim() : "";
	return {
		...base,
		init: {
			...(first.readme ? { readme: true } : {}),
			...(description ? { description } : {}),
			...(first.gitignore ? { gitignore: first.gitignore } : {}),
			...(first.license ? { license: first.license } : {}),
		},
	};
}

/** A new repository, in your own namespace or an org you may create in: imported, copied, or empty. */
export function NewRepoView({ orgs, repos, owner: wanted, create, onCreated }: NewRepoViewProps) {
	const owners = orgs ? creatableOwners(orgs) : [];
	const [owner, setOwner] = useState<string | null>(null);
	const chosen = owner ?? owners.find((o) => o.slug === wanted)?.slug ?? owners[0]?.slug ?? "";
	const [name, setName] = useState("");
	const [source, setSource] = useState<Source>("import");
	const [url, setUrl] = useState("");
	const [branch, setBranch] = useState("");
	const [token, setToken] = useState("");
	const [copyFrom, setCopyFrom] = useState("");
	const [visibility, setVisibility] = useState<"private" | "public">("private");
	const [first, setFirst] = useState<FirstCommit>(DEFAULT_FIRST_COMMIT);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const nameProblem = name ? repoNameProblem(name.trim()) : null;
	const ready =
		!!chosen &&
		!!name.trim() &&
		!nameProblem &&
		(source !== "import" || !!url.trim()) &&
		(source !== "copy" || !!copyFrom);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready) return;
		setBusy(true);
		setError(null);
		try {
			const input = newRepoInput({ owner: chosen, name, source, url, branch, token, copyFrom, visibility, first });
			onCreated(await create(input));
		} catch (err) {
			setError(messageOf(err));
			setBusy(false);
		}
	};

	if (orgs === undefined)
		return (
			<NewRepoFrame>
				<p className="muted" role="status">
					Loading…
				</p>
			</NewRepoFrame>
		);
	if (owners.length === 0)
		return (
			<NewRepoFrame>
				<div className="box empty">
					<h2>You can't make repositories here</h2>
					<p>Ask an owner of an organization to let members make repositories, or make one under your own name.</p>
				</div>
			</NewRepoFrame>
		);

	let nameHint: ReactNode = "Letters, digits, dots, underscores and dashes.";
	if (nameProblem) nameHint = <span className="error">{nameProblem}</span>;
	else if (chosen && name.trim()) nameHint = `It will be ${chosen}/${name.trim()}.`;
	let submitLabel = "Make repository";
	if (busy) submitLabel = source === "import" ? "Importing… (a big project takes a minute)" : "Making…";

	return (
		<NewRepoFrame>
			<form className="box manage__form" onSubmit={submit}>
				<div className="box__body manage__form">
					<OwnerAndName
						owners={owners}
						chosen={chosen}
						setOwner={setOwner}
						name={name}
						setName={setName}
						hint={nameHint}
					/>
					<RadioChoices
						legend="Start from"
						name="new-repo-source"
						value={source}
						onChange={setSource}
						options={SOURCES}
					/>
					{source === "import" ? (
						<ImportSource
							url={url}
							setUrl={setUrl}
							branch={branch}
							setBranch={setBranch}
							token={token}
							setToken={setToken}
						/>
					) : null}
					{source === "copy" ? <CopySource repos={repos} copyFrom={copyFrom} setCopyFrom={setCopyFrom} /> : null}
					{source === "empty" ? <FirstCommitFields first={first} setFirst={setFirst} /> : null}
					<RadioChoices
						legend="Who can see it"
						name="new-repo-visibility"
						value={visibility}
						onChange={setVisibility}
						options={VISIBILITIES}
					/>
					{error ? (
						<p className="error" role="alert">
							{error}
						</p>
					) : null}
					<div className="manage__actions">
						<button type="submit" className="accent" disabled={!ready || busy}>
							{submitLabel}
						</button>
						<a className="button" href={href.repos()}>
							Cancel
						</a>
					</div>
				</div>
			</form>
		</NewRepoFrame>
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
