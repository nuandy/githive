import { type FormEvent, type ReactNode, useState } from "react";
import type { ManageApi, MyOrg, NewRepoInput, RepoRecord } from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { creatableOwners, repoNameProblem } from "../lib/orgs";
import { href } from "../lib/routes";
import { messageOf } from "../lib/errors";
import { cn } from "../lib/utils";
import {
	CopySource,
	DEFAULT_FIRST_COMMIT,
	emptyFirstCommit,
	type FirstCommit,
	FirstCommitFields,
	Folding,
	ImportSource,
	NewRepoFrame,
	OwnerAndName,
	RadioChoices,
	type Source,
	SOURCES,
	VISIBILITIES,
} from "./NewRepoFields";
import { Box, BoxBody } from "./ui/box";
import { Button } from "./ui/button";

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

/** What the form still needs before it can be sent, said beside its button; null once it has it all. */
export function whatsMissing(form: { name: string; source: Source; url: string; copyFrom: string }): string | null {
	const name = form.name.trim();
	if (!name) return "Name it to make it.";
	if (repoNameProblem(name)) return "Fix the name to make it.";
	if (form.source === "import" && !form.url.trim()) return "Add the Git URL to import.";
	if (form.source === "copy" && !form.copyFrom) return "Choose the repository to copy.";
	return null;
}

/** A new repository, in your own namespace or an org you may create in: empty, imported, or copied. */
export function NewRepoView({ orgs, repos, owner: wanted, create, onCreated }: NewRepoViewProps) {
	const owners = orgs ? creatableOwners(orgs) : [];
	const [owner, setOwner] = useState<string | null>(null);
	const chosen = owner ?? owners.find((o) => o.slug === wanted)?.slug ?? owners[0]?.slug ?? "";
	const [name, setName] = useState("");
	const [source, setSource] = useState<Source>("empty");
	const [url, setUrl] = useState("");
	const [branch, setBranch] = useState("");
	const [token, setToken] = useState("");
	const [copyFrom, setCopyFrom] = useState("");
	const [visibility, setVisibility] = useState<"private" | "public">("private");
	const [first, setFirst] = useState<FirstCommit>(DEFAULT_FIRST_COMMIT);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The form, or why there's none, fades in as it takes the place of "Loading…".
	const appear = useChanged(orgs === undefined) && "animate-fade";

	const nameProblem = name ? repoNameProblem(name.trim()) : null;
	const missing = whatsMissing({ name, source, url, copyFrom });
	const ready = !!chosen && !missing;
	// As it says something else, it fades in.
	const missingChanged = useChanged(missing);

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
				<p className="my-3.75 text-muted-foreground" role="status">
					Loading…
				</p>
			</NewRepoFrame>
		);
	if (owners.length === 0)
		return (
			<NewRepoFrame>
				<Box className={cn("px-6 py-10 text-center", appear)}>
					<h2 className="mt-3 mb-2 text-title">You can't make repositories here</h2>
					<p className="mx-auto mt-0 mb-2 max-w-130 text-muted-foreground">
						Ask an owner of an organization to let members make repositories, or make one under your own name.
					</p>
				</Box>
			</NewRepoFrame>
		);

	let nameHint: ReactNode = "Letters, digits, dots, underscores and dashes.";
	let hintKey = "rules";
	if (nameProblem) {
		nameHint = <span className="text-bad">{nameProblem}</span>;
		hintKey = nameProblem;
	} else if (chosen && name.trim()) {
		nameHint = `It will be ${chosen}/${name.trim()}.`;
		hintKey = "name";
	}
	let submitLabel = "Make repository";
	if (busy) submitLabel = source === "import" ? "Importing… (a big project takes a minute)" : "Making…";

	return (
		<NewRepoFrame>
			<Box asChild className={cn("grid gap-4", appear)}>
				<form onSubmit={submit}>
					<BoxBody className="grid gap-4">
						<OwnerAndName
							owners={owners}
							chosen={chosen}
							setOwner={setOwner}
							name={name}
							setName={setName}
							hint={nameHint}
							hintKey={hintKey}
						/>
						<RadioChoices
							legend="Start from"
							name="new-repo-source"
							value={source}
							onChange={setSource}
							options={SOURCES}
						/>
						{/* What each source asks for folds open in its place as it's chosen, and the last one folds away. */}
						<div>
							<Folding open={source === "import"}>
								<ImportSource
									url={url}
									setUrl={setUrl}
									branch={branch}
									setBranch={setBranch}
									token={token}
									setToken={setToken}
								/>
							</Folding>
							<Folding open={source === "copy"}>
								<CopySource repos={repos} copyFrom={copyFrom} setCopyFrom={setCopyFrom} />
							</Folding>
							<Folding open={source === "empty"}>
								<FirstCommitFields first={first} setFirst={setFirst} />
							</Folding>
						</div>
						<RadioChoices
							legend="Who can see it"
							name="new-repo-visibility"
							value={visibility}
							onChange={setVisibility}
							options={VISIBILITIES}
						/>
						{error ? (
							<p className="my-3.75 animate-appear text-bad" role="alert">
								{error}
							</p>
						) : null}
						<div className="flex flex-wrap items-center gap-2">
							<Button
								type="submit"
								variant="primary"
								disabled={!ready || busy}
								aria-describedby={missing ? "new-repo-missing" : undefined}
							>
								{submitLabel}
							</Button>
							<Button asChild>
								<a href={href.repos()}>Cancel</a>
							</Button>
							{missing ? (
								<p
									key={missing}
									id="new-repo-missing"
									className={cn("m-0 text-meta text-muted-foreground", missingChanged && "animate-fade")}
								>
									{missing}
								</p>
							) : null}
						</div>
					</BoxBody>
				</form>
			</Box>
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
