import { Suspense, useState } from "react";
import type { RepoSnapshot } from "../api";
import { useShortcuts } from "../hooks/useShortcuts";
import { claimTitle } from "../lib/claimStatus";
import { href, type Route } from "../lib/routes";
import type { Shortcut } from "../lib/shortcuts";
import { lazyPart } from "./Lazy";
import { repoTabs } from "./RepoPage";

// The palette and the list of shortcuts load as they're first opened (components/Lazy.tsx); the keys are always heard.
const CommandPalette = lazyPart(() => import("./Keyboard").then((module) => module.CommandPalette));
const ShortcutsHelp = lazyPart(() => import("./Keyboard").then((module) => module.ShortcutsHelp));

/**
 * The dashboard's keyboard: its shortcuts, the palette they open and the list of them (which the user menu opens
 * too, through `help`). Once opened, each stays drawn, so it closes with its motion and gives focus back.
 */
export function DashboardKeys({
	route,
	repos,
	snapshot,
	people,
	operator = false,
	help,
	onHelp,
}: {
	route: Route;
	/** The reader's repos, most recently active first. */
	repos: string[];
	/** The repo shown's snapshot, once read. */
	snapshot: RepoSnapshot | undefined;
	/** A person signed in (not an Access operator). */
	people: boolean;
	/** One of GitHive's operators, through Cloudflare Access. */
	operator?: boolean;
	help: boolean;
	onHelp: (open: boolean) => void;
}) {
	const [palette, setPalette] = useState(false);
	const [opened, setOpened] = useState({ palette: false, help: false });
	if ((palette && !opened.palette) || (help && !opened.help))
		setOpened({ palette: opened.palette || palette, help: opened.help || help });
	const repo = route.page === "repo" || route.page === "change" ? route.repo : undefined;
	useShortcuts((shortcut: Shortcut) => {
		switch (shortcut.kind) {
			case "palette":
				setPalette((open) => !open);
				return true;
			case "help":
				onHelp(true);
				return true;
			case "go":
				window.location.hash = shortcut.to === "inbox" ? href.inbox() : href.repos();
				return true;
			case "search": {
				const field = route.page === "repos" ? document.getElementById("repo-search") : null;
				field?.focus();
				return !!field;
			}
			case "tab": {
				const tab = repo ? repoTabs(repo, snapshot)[shortcut.index] : undefined;
				if (!tab || tab.unavailable) return false;
				window.location.hash = tab.href;
				return true;
			}
		}
	});
	const changes =
		repo && snapshot ? snapshot.claims.map((claim) => ({ change: claim.change, title: claimTitle(claim) })) : [];
	const places = { repos, ...(repo ? { repo } : {}), changes, people, operator };
	return (
		<>
			{opened.palette ? (
				<Suspense fallback={null}>
					<CommandPalette open={palette} onOpenChange={setPalette} places={places} />
				</Suspense>
			) : null}
			{opened.help ? (
				<Suspense fallback={null}>
					<ShortcutsHelp open={help} onOpenChange={onHelp} />
				</Suspense>
			) : null}
		</>
	);
}
