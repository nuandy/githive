import { Icon, type IconName } from "./Icon";
import "./Tabs.css";

export interface TabItem {
	id: string;
	label: string;
	href: string;
	icon?: IconName;
	count?: number;
}

/** Underlined navigation tabs; each is a link so the browser's back button works. */
export function Tabs({ items, current, label }: { items: TabItem[]; current: string; label: string }) {
	return (
		<nav className="tabs" aria-label={label}>
			<ul>
				{items.map((item) => (
					<li key={item.id}>
						<a href={item.href} className="tabs__tab" aria-current={item.id === current ? "page" : undefined}>
							{item.icon ? <Icon name={item.icon} /> : null}
							<span>{item.label}</span>
							{item.count !== undefined ? <span className="counter">{item.count}</span> : null}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
