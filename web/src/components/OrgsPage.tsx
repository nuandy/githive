import { type FormEvent, useState } from "react";
import type { ManageApi, MyOrg, Org } from "../api";
import { usePoll } from "../hooks/usePoll";
import { realOrgs, SLUG_HINT, slugProblem } from "../lib/orgs";
import { href } from "../lib/routes";
import { messageOf } from "../lib/errors";
import { Icon } from "./Icon";
import "./Manage.css";

export interface OrgsViewProps {
	me: { handle: string };
	orgs: MyOrg[] | undefined;
	createOrg: (slug: string, name: string) => Promise<Org>;
	onCreated: (org: Org) => void;
}

/** Your repositories and the organizations you're in, and making an organization. */
export function OrgsView({ me, orgs, createOrg, onCreated }: OrgsViewProps) {
	return (
		<main className="page manage" id="main">
			<header>
				<h1>Your organizations</h1>
				<p className="muted manage__lede">
					An organization is a shared owner for repositories, with members and teams. You don't need one: your own
					repositories are under {me.handle}.
				</p>
			</header>

			<OrgList me={me} orgs={orgs} />

			<NewOrgForm createOrg={createOrg} onCreated={onCreated} />
		</main>
	);
}

/** Where your repositories live: under your own name, and in each organization you're in. */
function OrgList({ me, orgs }: Pick<OrgsViewProps, "me" | "orgs">) {
	const memberOf = orgs ? realOrgs(orgs) : [];
	return (
		<section className="box" aria-labelledby="orgs-title">
			<div className="box__header">
				<h2 id="orgs-title">Where your repositories live</h2>
			</div>
			<ul className="manage__rows">
				<li className="box__row manage__row">
					<div className="manage__row-main">
						<Icon name="user" className="muted" />
						<a href={href.org(me.handle)}>{me.handle}</a>
						<span className="muted">your repositories</span>
					</div>
				</li>
				{orgs === undefined ? (
					<li className="box__row muted" role="status">
						Loading…
					</li>
				) : (
					memberOf.map((org) => (
						<li key={org.slug} className="box__row manage__row">
							<div className="manage__row-main">
								<Icon name="repo" className="muted" />
								<a href={href.org(org.slug)}>{org.slug}</a>
								{org.name ? <span className="muted">{org.name}</span> : null}
							</div>
							<span className="pill pill--neutral">{org.role}</span>
						</li>
					))
				)}
			</ul>
		</section>
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
		<form className="box" onSubmit={submit} aria-labelledby="new-org-title">
			<div className="box__header">
				<h2 id="new-org-title">Create an organization</h2>
			</div>
			<div className="box__body manage__form">
				<div className="manage__field">
					<label htmlFor="new-org-slug">Name in URLs</label>
					<input
						id="new-org-slug"
						type="text"
						value={slug}
						onChange={(event) => setSlug(event.target.value.toLowerCase())}
						placeholder="acme"
						autoComplete="off"
						spellCheck={false}
						aria-describedby="new-org-slug-hint"
					/>
					<p className="manage__hint" id="new-org-slug-hint">
						<NewOrgHint slug={slug} problem={problem} />
					</p>
				</div>
				<div className="manage__field">
					<label htmlFor="new-org-name">Display name (optional)</label>
					<input
						id="new-org-name"
						type="text"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="Acme Inc."
						autoComplete="off"
					/>
				</div>
				{error ? (
					<p className="error" role="alert">
						{error}
					</p>
				) : null}
				<div className="manage__actions">
					<button type="submit" className="accent" disabled={!slug || !!problem || busy}>
						{busy ? "Creating…" : "Create organization"}
					</button>
				</div>
				<p className="manage__hint">
					You'll be its owner. Then add members by email, and make teams to grant roles to, like @{slug || "acme"}
					/security.
				</p>
			</div>
		</form>
	);
}

/** Under the new org's name: what's wrong with it, where its repositories will be, or what a name may be. */
function NewOrgHint({ slug, problem }: { slug: string; problem: string | null }) {
	if (problem) return <span className="error">{problem}</span>;
	if (slug) return <>{`Its repositories will be ${slug}/<name>.`}</>;
	return <>{SLUG_HINT}</>;
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
