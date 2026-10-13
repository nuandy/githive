import type { ReactNode } from "react";
import type { Gitignore, MyOrg } from "../api";
import { useChanged } from "../hooks/useChanged";
import { cn } from "../lib/utils";
import { Page } from "./Page";
import { Fold } from "./ui/collapse";
import { Field, FieldHint, Input, Label, NativeSelect } from "./ui/field";

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

// A text field or a select: as wide as a name needs.
const WIDE = "w-full max-w-120";
// A group of choices: no box of its own, its legend a field's label (with the 2px either side a legend has).
const CHOICES = "m-0 min-w-0 border-0 p-0";
const LEGEND = "px-0.5 text-body-sm font-semibold";

/** The page around the form, or around what shows instead of it. */
export function NewRepoFrame({ children }: { children: ReactNode }) {
	return (
		<Page id="main" className="grid gap-5">
			<header>
				<h1 className="text-display-sm tracking-[-0.01em]">New repository</h1>
				<p className="mt-1 mb-0 text-muted-foreground">
					GitHive starts on it as it's made, so agents can claim work in it at once. Its review policy and checks are in
					its Settings.
				</p>
			</header>
			{children}
		</Page>
	);
}

/** Fields that fold open in place and away again, with room at their sides and foot for a focused field's ring. */
export function Folding({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
	return (
		<Fold open={open} className="-mx-1 -mb-1">
			<div className={cn("px-1 pb-1", className)}>{children}</div>
		</Fold>
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
	/** What the hint says, in a word: as it says something else (a problem, say), it fades in. */
	hintKey: string;
}) {
	const { owners, chosen, setOwner, name, setName, hint, hintKey } = props;
	const changed = useChanged(hintKey);
	return (
		<>
			<Field>
				<Label htmlFor="new-repo-owner" className="text-body-sm">
					Owner
				</Label>
				<NativeSelect id="new-repo-owner" className={WIDE} value={chosen} onChange={(e) => setOwner(e.target.value)}>
					{owners.map((o) => (
						<option key={o.slug} value={o.slug}>
							{o.personal ? `${o.slug} (you)` : o.slug}
						</option>
					))}
				</NativeSelect>
			</Field>
			<Field>
				<Label htmlFor="new-repo-name" className="text-body-sm">
					Name
				</Label>
				<Input
					id="new-repo-name"
					type="text"
					className={WIDE}
					value={name}
					onChange={(e) => setName(e.target.value)}
					autoComplete="off"
					spellCheck={false}
					placeholder="my-project"
					aria-describedby="new-repo-name-hint"
				/>
				<FieldHint key={hintKey} id="new-repo-name-hint" className={cn(changed && "animate-fade")}>
					{hint}
				</FieldHint>
			</Field>
		</>
	);
}

export type Choice<T> = { value: T; title: string; detail: string };

export const SOURCES: Choice<Source>[] = [
	{ value: "empty", title: "Start fresh", detail: "A new repository with a first commit, ready for agents." },
	{
		value: "import",
		title: "A Git repository",
		detail: "Imported from its URL, for example a public GitHub repository.",
	},
	{ value: "copy", title: "A copy of a repository here", detail: "Its default branch, in seconds." },
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
		<fieldset className={cn("grid gap-2", CHOICES)}>
			<legend className={LEGEND}>{legend}</legend>
			{options.map((option) => (
				<Label key={option.value} className="flex cursor-pointer items-start gap-2 text-body-sm">
					{/* The browser's own margins about a radio button, the top one a little more to sit with the title. */}
					<input
						type="radio"
						className="mt-0.75 mr-0.75 mb-0 ml-1.25"
						name={name}
						value={option.value}
						checked={value === option.value}
						onChange={() => onChange(option.value)}
					/>
					<span>
						<strong className="block">{option.title}</strong>
						<span className="text-muted-foreground">{option.detail}</span>
					</span>
				</Label>
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
		<div className="grid gap-3">
			<Field>
				<Label htmlFor="new-repo-url" className="text-body-sm">
					Git URL
				</Label>
				<Input
					id="new-repo-url"
					type="url"
					className={WIDE}
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://github.com/octocat/Spoon-Knife"
					autoComplete="off"
					spellCheck={false}
				/>
			</Field>
			{/* The URL as wide as the name above it, the branch a short field below. */}
			<Field>
				<Label htmlFor="new-repo-branch" className="text-body-sm">
					Branch (optional)
				</Label>
				<Input
					id="new-repo-branch"
					type="text"
					className="w-full max-w-48"
					value={branch}
					onChange={(e) => setBranch(e.target.value)}
					placeholder="main"
					autoComplete="off"
					spellCheck={false}
				/>
			</Field>
			<Field>
				<Label htmlFor="new-repo-token" className="text-body-sm">
					Access token, for a private repo (optional)
				</Label>
				<Input
					id="new-repo-token"
					type="password"
					className={WIDE}
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="github_pat_…"
					autoComplete="off"
					spellCheck={false}
					aria-describedby="new-repo-token-hint"
				/>
				<FieldHint id="new-repo-token-hint">
					On GitHub, make a{" "}
					<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
						fine-grained token
					</a>{" "}
					with read-only access to this repository's contents. GitHive uses it once to clone the repository, and keeps
					it nowhere.
				</FieldHint>
			</Field>
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
		<Field>
			<Label htmlFor="new-repo-copy" className="text-body-sm">
				Repository to copy
			</Label>
			<NativeSelect id="new-repo-copy" className={WIDE} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
				<option value="">Choose one…</option>
				{(repos ?? []).map((r) => (
					<option key={r.name} value={r.name}>
						{r.name}
					</option>
				))}
			</NativeSelect>
		</Field>
	);
}

/** What a fresh repository's first commit holds. A README's description folds open with it. */
export function FirstCommitFields({ first, setFirst }: { first: FirstCommit; setFirst: (first: FirstCommit) => void }) {
	const empty = emptyFirstCommit(first);
	// As the hint says something else, it fades in.
	const changed = useChanged(empty);
	return (
		<fieldset className={cn("grid gap-2.5", CHOICES)}>
			<legend className={LEGEND}>First commit</legend>
			<div>
				<Label className="flex items-center gap-2 text-body-sm">
					{/* The browser's own margins about a checkbox. */}
					<input
						type="checkbox"
						className="mt-0.75 mr-0.75 mb-0.75 ml-1"
						checked={first.readme}
						onChange={(e) => setFirst({ ...first, readme: e.target.checked })}
					/>
					<span>Add a README</span>
				</Label>
				<Folding open={first.readme} className="pt-2.5">
					<Field>
						<Label htmlFor="new-repo-description" className="text-body-sm">
							Description (optional)
						</Label>
						<Input
							id="new-repo-description"
							type="text"
							className={WIDE}
							value={first.description}
							onChange={(e) => setFirst({ ...first, description: e.target.value })}
							placeholder="Shown under the name in the README"
							maxLength={300}
							autoComplete="off"
						/>
					</Field>
				</Folding>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Field>
					<Label htmlFor="new-repo-gitignore" className="text-body-sm">
						.gitignore
					</Label>
					<NativeSelect
						id="new-repo-gitignore"
						className={WIDE}
						value={first.gitignore}
						onChange={(e) => setFirst({ ...first, gitignore: e.target.value as FirstCommit["gitignore"] })}
					>
						<option value="">None</option>
						{GITIGNORES.map((g) => (
							<option key={g.value} value={g.value}>
								{g.label}
							</option>
						))}
					</NativeSelect>
				</Field>
				<Field>
					<Label htmlFor="new-repo-license" className="text-body-sm">
						License
					</Label>
					<NativeSelect
						id="new-repo-license"
						className={WIDE}
						value={first.license}
						onChange={(e) => setFirst({ ...first, license: e.target.value as FirstCommit["license"] })}
					>
						<option value="">None</option>
						<option value="mit">MIT</option>
					</NativeSelect>
				</Field>
			</div>
			<FieldHint key={String(empty)} className={cn(changed && "animate-fade")}>
				{empty
					? "With nothing in it, the repository has no branch: GitHive can't " +
						"start on it, and agents can't work in it, until someone pushes a " +
						"first commit."
					: "A .gitignore keeps build output and dependencies (node_modules, " +
						".venv, target) out of commits, and out of agents' claims."}
			</FieldHint>
		</fieldset>
	);
}
