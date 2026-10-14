import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { ManageApi, MyOrg, NewRepoInput, RepoRecord } from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { creatableOwners, repoNameProblem, repoNameTyping } from "../lib/orgs";
import { href } from "../lib/routes";
import { reasonOf, sentence, statusOf } from "../lib/errors";
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

/** The parts of the form a server's error can be about; "form" when it's none of them. */
export type FormField = "owner" | "name" | "url" | "copy" | "form";

/** A server's error, as the form shows it: in the field it's about, until what it was about changes. */
export interface ServerError {
	field: FormField;
	status?: number;
	/** The server's words. */
	text: string;
}

/**
 * Which field a server's error is about: a name that's taken or refused, an owner that can't be made in, else what the
 * repo was to start from (the import's URL, the repo to copy), else the form as a whole.
 */
export function fieldOfError(status: number | undefined, text: string, source: Source): FormField {
	if (status === 409 || (status === 400 && /\bname\b/.test(text))) return "name";
	if (status === 403 || /^no org /.test(text)) return "owner";
	if (source === "import") return "url";
	if (source === "copy") return "copy";
	return "form";
}

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
	/** The form as it starts (tests start it filled in, or after a failure). */
	initial?: { name?: string; source?: Source; url?: string; copyFrom?: string; serverError?: ServerError };
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
export function NewRepoView({ orgs, repos, owner: wanted, create, onCreated, initial = {} }: NewRepoViewProps) {
	const owners = orgs ? creatableOwners(orgs) : [];
	const [owner, setOwner] = useState<string | null>(null);
	const chosen = owner ?? owners.find((o) => o.slug === wanted)?.slug ?? owners[0]?.slug ?? "";
	const [name, setName] = useState(initial.name ?? "");
	// Once the name's field has been left, its length and a name of dots are checked too; while it's typed, only its
	// characters.
	const [nameLeft, setNameLeft] = useState(false);
	const [source, setSource] = useState<Source>(initial.source ?? "empty");
	const [url, setUrl] = useState(initial.url ?? "");
	const [branch, setBranch] = useState("");
	const [token, setToken] = useState("");
	const [copyFrom, setCopyFrom] = useState(initial.copyFrom ?? "");
	const [visibility, setVisibility] = useState<"private" | "public">("private");
	const [first, setFirst] = useState<FirstCommit>(DEFAULT_FIRST_COMMIT);
	const [busy, setBusy] = useState(false);
	// The server's error, with what the field it's about held when it came: it shows until that changes.
	const [failed, setFailed] = useState<(ServerError & { about: string }) | null>(null);
	// The form, or why there's none, fades in as it takes the place of "Loading…".
	const appear = useChanged(orgs === undefined) && "animate-fade";

	const trimmed = name.trim();
	const fullName = `${chosen}/${trimmed}`;
	const about: Record<FormField, string> = {
		owner: chosen,
		name: fullName,
		url: `${url}\n${branch}\n${token}`,
		copy: copyFrom,
		form: `${fullName}\n${source}`,
	};
	// A form that starts after a failure holds it against what it starts with.
	const [startedWith] = useState(() =>
		initial.serverError ? { ...initial.serverError, about: about[initial.serverError.field] } : null,
	);
	const shown = failed ?? startedWith;
	const serverError = shown && shown.about === about[shown.field] ? shown : null;
	const errorIn = (field: FormField) => (serverError?.field === field ? serverError : null);

	const nameProblem = trimmed ? (nameLeft ? repoNameProblem(trimmed) : repoNameTyping(trimmed)) : null;
	const missing = whatsMissing({ name, source, url, copyFrom });
	const ready = !!chosen && !missing;
	// As it says something else, it fades in.
	const missingChanged = useChanged(missing);

	// A failure moves focus to the field it's about, so it's read out there.
	useEffect(() => {
		if (failed && failed.field !== "form") document.getElementById(FIELD_IDS[failed.field])?.focus();
	}, [failed]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready) return;
		setBusy(true);
		setFailed(null);
		try {
			const input = newRepoInput({ owner: chosen, name, source, url, branch, token, copyFrom, visibility, first });
			onCreated(await create(input));
		} catch (err) {
			const status = statusOf(err);
			const text = reasonOf(err);
			const field = fieldOfError(status, text, source);
			setFailed({ field, text, about: about[field], ...(status ? { status } : {}) });
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
	const nameError = errorIn("name");
	if (nameProblem) {
		nameHint = <span className="text-bad">{nameProblem}</span>;
		hintKey = nameProblem;
	} else if (nameError) {
		nameHint = <NameError error={nameError} fullName={fullName} />;
		hintKey = `server:${nameError.text}`;
	} else if (chosen && trimmed) {
		nameHint = `It will be ${fullName}.`;
		hintKey = "name";
	}
	const formError = errorIn("form");
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
							ownerError={errorIn("owner")?.text ?? null}
							name={name}
							setName={setName}
							onNameLeft={() => setNameLeft(true)}
							hint={nameHint}
							hintKey={hintKey}
							nameInvalid={!!nameProblem || !!nameError}
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
									error={errorIn("url")?.text ?? null}
								/>
							</Folding>
							<Folding open={source === "copy"}>
								<CopySource
									repos={repos}
									copyFrom={copyFrom}
									setCopyFrom={setCopyFrom}
									error={errorIn("copy")?.text ?? null}
								/>
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
						{formError ? (
							<p className="my-3.75 animate-appear text-bad" role="alert">
								{sentence(formError.text)}
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

/** Each field's control, to move focus to when a failure is about it. */
const FIELD_IDS: Record<Exclude<FormField, "form">, string> = {
	owner: "new-repo-owner",
	name: "new-repo-name",
	url: "new-repo-url",
	copy: "new-repo-copy",
};

/** The server's word on a name: one that's taken, with a way to open it, or why it's refused. */
function NameError({ error, fullName }: { error: ServerError; fullName: string }) {
	if (error.status !== 409) return <span className="text-bad">{sentence(error.text)}</span>;
	return (
		<span className="text-bad">
			{fullName} already exists. Choose another name, or <a href={href.repo(fullName)}>open it</a>.
		</span>
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
