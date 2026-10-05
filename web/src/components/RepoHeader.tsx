import type { RepoMode } from "../lib/repos";
import { Icon } from "./Icon";
import { ModeBadge } from "./StatusPill";
import { Tabs, type TabItem } from "./Tabs";
import "./RepoHeader.css";

/** A repo's name, mode and tabs, at the top of every page in it. */
export function RepoHeader({ name, mode, tabs, current, homeHref }: { name: string; mode: RepoMode; tabs: TabItem[]; current: string; homeHref: string }) {
	return (
		<div className="repo-header">
			<div className="repo-header__inner">
				<h1 className="repo-header__title">
					<Icon name="repo" className="muted" />
					<a href={homeHref}>{name}</a>
					<ModeBadge mode={mode} />
				</h1>
				<Tabs items={tabs} current={current} label={`${name} sections`} />
			</div>
		</div>
	);
}
