import { type FormEvent, type ReactNode, useState } from "react";
import type { ManageApi, MyOrg, Org } from "../api";
import { useChanged } from "../hooks/useChanged";
import { usePoll } from "../hooks/usePoll";
import { realOrgs, SLUG_HINT, slugProblem } from "../lib/orgs";
import { href } from "../lib/routes";
import { messageOf } from "../lib/errors";
import { cn } from "../lib/utils";
import { Icon } from "./Icon";
import { Page, PageHeader } from "./Page";
import { Badge } from "./ui/badge";
import { Box, BoxBody, BoxHeader } from "./ui/box";
import { Button } from "./ui/button";
import { Field, FieldHint, Input, Label } from "./ui/field";

export interface OrgsViewProps {
	me: { handle: string };
	orgs: MyOrg[] | undefined;
	createOrg: (slug: string, name: string) => Promise<Org>;
	onCreated: (org: Org) => void;
}

/** Your repositories and the organizations you're in, and making an organization. */
export function OrgsView({ me, orgs, createOrg, onCreated }: OrgsViewProps) {
	return (
		<Page className="grid gap-5">
			<PageHeader
				className="mb-0"
				title="Your organizations"
				description={
					<>
						An organization is a shared owner for repositories, with members and teams. You don't need one: your own
						repositories are under {me.handle}.
					</>
				}
			/>

			<OrgList me={me} orgs={orgs} />

			<NewOrgForm createOrg={createOrg} onCreated={onCreated} />
		</Page>
	);
}

// A row in the list, ruled off from the one above (the first, too, from the box's header): where repositories live,
// and in which role.
const ROW = "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-0.5 py-3";
const ROW_MAIN = "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 wrap-anywhere";

/** Where your repositories live: under your own name, and in each organization you're in. */
function OrgList({ me, orgs }: Pick<OrgsViewProps, "me" | "orgs">) {
	const memberOf = orgs ? realOrgs(orgs) : [];
	// The orgs fade in as they take the place of "Loading…".
	const appear = useChanged(orgs === undefined) && "animate-fade";
	return (
		<Box aria-labelledby="orgs-title">
			<BoxHeader>
				<h2 id="orgs-title" className="text-lead">
					Where your repositories live
				</h2>
			</BoxHeader>
			<ul className="m-0 list-none p-0">
				<li className={ROW}>
					<div className={ROW_MAIN}>
						<Icon name="user" className="text-muted-foreground" />
						<a href={href.org(me.handle)}>{me.handle}</a>
						<span className="text-muted-foreground">your repositories</span>
					</div>
				</li>
				{orgs === undefined ? (
					<li className="border-t border-border px-0.5 py-3 text-muted-foreground" role="status">
						Loading…
					</li>
				) : (
					memberOf.map((org) => (
						<li key={org.slug} className={cn(ROW, appear)}>
							<div className={ROW_MAIN}>
								<Icon name="repo" className="text-muted-foreground" />
								<a href={href.org(org.slug)}>{org.slug}</a>
								{org.name ? <span className="text-muted-foreground">{org.name}</span> : null}
							</div>
							<Badge tone="neutral">{org.role}</Badge>
						</li>
					))
				)}
			</ul>
		</Box>
	);
}

/** Names and creates an organization, which you'll own. */
function NewOrgForm({ createOrg, onCreated }: Pick<OrgsViewProps, "createOrg" | "onCreated">) {
	const [slug, setSlug] = useState("");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const problem = slug ? slugProblem(slug) : null;

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!slug || problem) return;
		setBusy(true);
		setError(null);
		try {
			onCreated(await createOrg(slug, name.trim()));
		} catch (err) {
			setError(messageOf(err));
			setBusy(false);
		}
	};

	return (
		<Box asChild>
			<form onSubmit={submit} aria-labelledby="new-org-title">
				<BoxHeader>
					<h2 id="new-org-title" className="text-lead">
						Create an organization
					</h2>
				</BoxHeader>
				<BoxBody className="grid gap-4">
					<Field>
						<Label htmlFor="new-org-slug" className="text-body-sm">
							Name in URLs
						</Label>
						<Input
							id="new-org-slug"
							type="text"
							className="w-full max-w-120"
							value={slug}
							onChange={(event) => setSlug(event.target.value.toLowerCase())}
							placeholder="acme"
							autoComplete="off"
							spellCheck={false}
							aria-describedby="new-org-slug-hint"
						/>
						<NewOrgHint slug={slug} problem={problem} />
					</Field>
					<Field>
						<Label htmlFor="new-org-name" className="text-body-sm">
							Display name (optional)
						</Label>
						<Input
							id="new-org-name"
							type="text"
							className="w-full max-w-120"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Acme Inc."
							autoComplete="off"
						/>
					</Field>
					{error ? (
						<p className="my-3.75 animate-appear text-bad" role="alert">
							{error}
						</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						<Button type="submit" variant="primary" disabled={!slug || !!problem || busy}>
							{busy ? "Creating…" : "Create organization"}
						</Button>
					</div>
					<FieldHint>
						You'll be its owner. Then add members by email, and make teams to grant roles to, like @{slug || "acme"}
						/security.
					</FieldHint>
				</BoxBody>
			</form>
		</Box>
	);
}

/**
 * Under the new org's name: what's wrong with it, where its repositories will be, or what a name may be. As it says
 * something else (a problem, say), it fades in.
 */
function NewOrgHint({ slug, problem }: { slug: string; problem: string | null }) {
	let said: ReactNode = SLUG_HINT;
	if (problem) said = <span className="text-bad">{problem}</span>;
	else if (slug) said = `Its repositories will be ${slug}/<name>.`;
	const say = problem ?? (slug ? "where" : "rules");
	const changed = useChanged(say);
	return (
		<FieldHint key={say} id="new-org-slug-hint" className={cn(changed && "animate-fade")}>
			{said}
		</FieldHint>
	);
}

/** The page, with its data. */
export function OrgsPage({ me, manage }: { me: { handle: string }; manage: ManageApi }) {
	const orgs = usePoll("orgs", manage.orgs, 60_000);
	return (
		<OrgsView
			me={me}
			orgs={orgs.data ?? (orgs.error ? [] : undefined)}
			createOrg={manage.createOrg}
			onCreated={(org) => {
				window.location.hash = href.org(org.slug);
			}}
		/>
	);
}
