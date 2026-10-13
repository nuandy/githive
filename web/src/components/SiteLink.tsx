import { href } from "../lib/routes";
import { Icon } from "./Icon";

/**
 * A public repo's site, or a change's preview of it, opened in its own tab. GitHive serves it from the repo's files
 * (see src/routes/site.ts).
 */
export function SiteLink({ repo, change }: { repo: string; change?: string }) {
	const label = change ? "Preview" : "View site";
	const title = change
		? "This change's version of the site, from its latest push"
		: "The site as the default branch has it, served from the repo's files";
	return (
		<a
			className="inline-flex items-center gap-1.5 rounded-xl border border-border px-2.5 py-0.75 text-ui whitespace-nowrap text-link transition-colors duration-fast hover:border-link"
			href={href.site(repo, change)}
			target="_blank"
			rel="noopener noreferrer"
			title={title}
		>
			<Icon name="eye" />
			{label}
		</a>
	);
}
