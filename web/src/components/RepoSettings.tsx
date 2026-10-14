import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { MyAgent, OrgDetail, RepoAccess, RepoSnapshot, SettingsInput } from "../api";
import { useChanged } from "../hooks/useChanged";
import { splitRepo } from "../lib/repoName";
import { href, SECTION_TITLES, SETTINGS_SECTIONS, type SettingsSection } from "../lib/routes";
import { type DraftStore, dirtySections, forgetDrafts, settingsDrafts } from "../lib/settingsDrafts";
import { holderOptions, roleOptions } from "../lib/tokens";
import { cn } from "../lib/utils";
import { BranchRulesSection } from "./BranchRules";
import { GitHubSection } from "./GitHubSettings";
import { ChecksSection, PathRulesSection, ReviewSection, type SettingsContext } from "./MergeSettings";
import { RecordsTerms } from "./PolicyTerms";
import { DangerZone, GeneralSection, type RepoManageApi } from "./RepoAdmin";
import { Box } from "./ui/box";
import { Empty } from "./ui/empty";
import { TERMS } from "./ui/manage";

// A repo's Settings, for its admins: a page per section, chosen from a nav beside them (a strip above them on a narrow
// window), each saving on its own. Edits are held for the session (settingsDrafts), so moving between sections or tabs
// keeps them; a section with edits has a dot in the nav, and closing the window with any asks first.

/** The sections a repo has: all of them once GitHive has started on it; before, only who may do what, and deleting. */
export const sectionsOf = (started: boolean): readonly SettingsSection[] =>
	started ? SETTINGS_SECTIONS : ["general", "danger-zone"];

export interface RepoSettingsProps {
	repo: string;
	branch: string;
	section: SettingsSection;
	/** Its claims and settings; null before GitHive starts on it. */
	snapshot: RepoSnapshot | null;
	access: RepoAccess | undefined;
	manage: RepoManageApi;
	/** After a save: refresh what the page shows. */
	onSaved?(): void;
	/** After its visibility or access changes. */
	onAccessChanged(): void;
	onDeleted(): void;
	/** Where edits are held (tests pass their own). */
	drafts?: DraftStore;
}

export function RepoSettings({
	repo,
	branch,
	section,
	snapshot,
	access,
	manage,
	onSaved,
	onAccessChanged,
	onDeleted,
	drafts = settingsDrafts,
}: RepoSettingsProps) {
	const editing = !!snapshot && !!manage.changeSettings;
	const sections = sectionsOf(editing);
	const options = useTokenOptions(repo, manage, editing ? snapshot : null);
	const dirty = useSyncExternalStore(
		drafts.subscribe,
		() => [...dirtySections(drafts, repo)].join(),
		() => [...dirtySections(drafts, repo)].join(),
	);
	// Another section fades in as it takes this one's place.
	const switched = useChanged(section);

	let shown;
	if (!sections.includes(section)) {
		shown = (
			<Box asChild>
				<Empty>
					<h2>
						{SECTION_TITLES[section]} shows once GitHive starts on {repo}
					</h2>
					<p>
						Until then, <a href={href.settings(repo)}>General &amp; access</a> says who may do what.
					</p>
				</Empty>
			</Box>
		);
	} else if (section === "general") {
		shown = (
			<GeneralSection
				repo={repo}
				access={access}
				manage={manage}
				onChanged={onAccessChanged}
				records={snapshot ? <Records snapshot={snapshot} /> : undefined}
			/>
		);
	} else if (section === "danger-zone") {
		shown = (
			<DangerZone
				repo={repo}
				deleteRepo={() => manage.deleteRepo(repo)}
				onDeleted={() => {
					// Its edits go with it.
					forgetDrafts(drafts, repo);
					onDeleted();
				}}
			/>
		);
	} else if (snapshot && manage.changeSettings) {
		const context: SettingsContext = {
			repo,
			branch,
			snapshot,
			save: (settings: SettingsInput) => manage.changeSettings!(repo, settings),
			...(onSaved ? { onSaved } : {}),
			drafts,
			options,
		};
		const Section = {
			review: ReviewSection,
			"path-rules": PathRulesSection,
			"branch-rules": BranchRulesSection,
			checks: ChecksSection,
			github: GitHubSection,
		}[section];
		shown = <Section {...context} />;
	}

	return (
		<div className="grid grid-cols-[minmax(150px,190px)_minmax(0,1fr)] items-start gap-x-8 to-900:grid-cols-1 to-900:gap-y-4">
			<SettingsNav repo={repo} sections={sections} current={section} dirty={dirty ? dirty.split(",") : []} />
			<div key={section} className={cn("min-w-0 max-w-205", switched && "animate-fade")}>
				{shown}
			</div>
		</div>
	);
}

/**
 * The sections, as links: down the side on a wide window, a strip that scrolls sideways on a narrow one, keeping the
 * current one in view. A section with edits not yet saved has a dot.
 */
function SettingsNav({
	repo,
	sections,
	current,
	dirty,
}: {
	repo: string;
	sections: readonly SettingsSection[];
	current: SettingsSection;
	dirty: string[];
}) {
	const list = useRef<HTMLUListElement>(null);
	useEffect(() => {
		const strip = list.current;
		const item = strip?.querySelector<HTMLElement>('[aria-current="page"]');
		if (strip && item && strip.scrollWidth > strip.clientWidth)
			strip.scrollLeft = item.offsetLeft - (strip.clientWidth - item.offsetWidth) / 2;
	}, [current]);
	return (
		<nav aria-label="Settings" className="sticky top-4 min-w-0 to-900:static">
			<ul
				ref={list}
				className={cn(
					"m-0 grid list-none gap-0.5 p-0",
					"to-900:-mx-1 to-900:flex to-900:gap-1 to-900:overflow-x-auto to-900:border-b to-900:border-border to-900:px-1 to-900:pb-1.5",
				)}
			>
				{sections.map((section) => {
					const here = section === current;
					const edited = dirty.includes(section);
					return (
						<li key={section} className="to-900:shrink-0">
							<a
								href={href.settings(repo, section)}
								aria-current={here ? "page" : undefined}
								className={cn(
									"flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 font-medium whitespace-nowrap no-underline",
									"text-muted-foreground transition-colors duration-fast hover:bg-surface-2 hover:text-foreground hover:no-underline",
									"aria-[current=page]:bg-surface-3 aria-[current=page]:font-semibold aria-[current=page]:text-foreground",
									section === "danger-zone" && "text-bad hover:text-bad aria-[current=page]:text-bad",
								)}
							>
								{SECTION_TITLES[section]}
								{edited ? (
									<>
										<span aria-hidden="true" className="size-2 shrink-0 animate-appear rounded-full bg-foreground" />
										<span className="sr-only">, edits not saved</span>
									</>
								) : null}
							</a>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

/** How the records are kept, folded away under General: rarely what an admin came for. */
function Records({ snapshot }: { snapshot: RepoSnapshot }) {
	return (
		<details
			className={cn(
				"disclosure mt-2 border-t border-border px-0.5 py-3",
				"[&>summary]:cursor-pointer [&>summary]:font-semibold [&>summary]:text-muted-foreground",
			)}
		>
			<summary>How the records are kept</summary>
			<dl className={cn(TERMS, "mt-3")}>
				<RecordsTerms snapshot={snapshot} />
			</dl>
		</details>
	);
}

/**
 * What the token inputs offer: the roles the repo uses and its org's teams' names; and who may vote, as the presets,
 * the org's teams and the reader's agents. What can't be read (an org the reader isn't in) is left out.
 */
function useTokenOptions(repo: string, manage: RepoManageApi, snapshot: RepoSnapshot | null) {
	const [teams, setTeams] = useState<OrgDetail["teams"]>([]);
	const [agents, setAgents] = useState<MyAgent[]>([]);
	const { owner } = splitRepo(repo);
	const reading = !!snapshot;
	useEffect(() => {
		if (!reading) return;
		let live = true;
		manage.org?.(owner).then(
			(org) => live && setTeams(org.teams),
			() => undefined,
		);
		manage.agents?.().then(
			(list) => live && setAgents(list),
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [repo, reading]);
	const used = snapshot
		? [
				...snapshot.policy.vetoes,
				...(snapshot.policy.escalate ?? []).flatMap((rule) => rule.vetoes ?? []),
				...(snapshot.branchRules ?? []).flatMap((rule) => rule.policy?.vetoes ?? []),
			]
		: [];
	return {
		roles: roleOptions([...new Set(used)], teams, owner),
		holders: holderOptions({
			teams,
			org: owner,
			agents: agents.map((agent) => ({ name: agent.name, revoked: !!agent.revokedAt })),
		}),
	};
}
