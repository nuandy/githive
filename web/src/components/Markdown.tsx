import { Component, type ErrorInfo, Fragment, type ReactNode, useMemo } from "react";
import { languageOf } from "../lib/highlight";
import { type Block, type Inline, linkTarget, parseMarkdown } from "../lib/markdown";
import { cn } from "../lib/utils";
import { TokenLine, useHighlighted } from "./Highlighted";

// A Markdown file as formatted text (lib/markdown.ts reads it): React elements only, so nothing in the file reaches
// the page as HTML. Links go where linkTarget lets them, or show as their words. Its headings sit a level under the
// page's, and a file that can't be drawn shows its fallback (its source) rather than taking the page down.

export interface MarkdownProps {
	source: string;
	/** Where the file is: its repo, its folder, and the ref it's read at, for its relative links. */
	repo: string;
	dir: string;
	gitRef?: string;
	className?: string;
	/** What shows in its place if it can't be formatted: its source, say. */
	fallback?: ReactNode;
}

type Where = Pick<MarkdownProps, "repo" | "dir"> & { ref: string | undefined };

/** Each heading's look, by its level in the file (it's drawn a level down: see BlockView). */
const HEADING = [
	"",
	"mt-6 mb-3 border-b border-border pb-1.5 text-display-sm first:mt-0",
	"mt-6 mb-3 border-b border-border pb-1.5 text-title first:mt-0",
	"mt-5 mb-2 text-lead first:mt-0",
	"mt-4 mb-2 text-body first:mt-0",
	"mt-4 mb-2 text-body-sm first:mt-0",
	"mt-4 mb-2 text-body-sm text-muted-foreground first:mt-0",
];

function Link({ url, where, children }: { url: string; where: Where; children: ReactNode }) {
	const target = linkTarget(url, where);
	if (!target) return <span>{children}</span>;
	return target.external ? (
		<a href={target.href} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	) : (
		<a href={target.href}>{children}</a>
	);
}

function Inlines({ inlines, where }: { inlines: Inline[]; where: Where }) {
	return (
		<>
			{inlines.map((inline, index) => {
				switch (inline.kind) {
					case "text":
						return inline.text;
					case "code":
						return <code key={index}>{inline.text}</code>;
					case "em":
						return (
							<em key={index}>
								<Inlines inlines={inline.children} where={where} />
							</em>
						);
					case "strong":
						return (
							<strong key={index}>
								<Inlines inlines={inline.children} where={where} />
							</strong>
						);
					case "del":
						return (
							<del key={index}>
								<Inlines inlines={inline.children} where={where} />
							</del>
						);
					case "link":
						return (
							<Link key={index} url={inline.href} where={where}>
								<Inlines inlines={inline.children} where={where} />
							</Link>
						);
					case "image":
						// Pictures aren't loaded from a file's text: its words stand in, linked to the picture.
						return (
							<Link key={index} url={inline.src} where={where}>
								[{inline.alt || "image"}]
							</Link>
						);
					case "break":
						return <br key={index} />;
					case "task":
						// A task list's box: it says whether it's ticked, and can't be changed here. It hangs where the
						// item's bullet would be.
						return (
							<input
								key={index}
								type="checkbox"
								disabled
								checked={inline.checked}
								className="mr-1.5 -ml-5.5 size-3.5 align-[-2px]"
							/>
						);
				}
			})}
		</>
	);
}

/** A fenced block of code, in its syntax colors once they load when its fence names a language the tab colors. */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
	const lines = useHighlighted(text, lang ? languageOf("", lang) : undefined);
	return (
		<pre className="mt-0 mb-3 overflow-x-auto bg-surface-2 text-caption leading-[1.6] whitespace-pre">
			<code>
				{lines
					? lines.map((line, index) => (
							<Fragment key={index}>
								{index ? "\n" : ""}
								<TokenLine tokens={line} />
							</Fragment>
						))
					: text}
			</code>
		</pre>
	);
}

function Blocks({ blocks, where, tight = false }: { blocks: Block[]; where: Where; tight?: boolean }) {
	return (
		<>
			{blocks.map((block, index) => (
				<BlockView key={index} block={block} where={where} tight={tight} />
			))}
		</>
	);
}

const TEXT = "max-w-measure";

function BlockView({ block, where, tight }: { block: Block; where: Where; tight: boolean }) {
	switch (block.kind) {
		case "heading": {
			// A level under the file's own, so its "# Title" sits under the page's h1 (the repo's name).
			const Tag = `h${Math.min(block.level + 1, 6)}` as "h2";
			return (
				<Tag className={cn("font-semibold", HEADING[block.level])}>
					<Inlines inlines={block.children} where={where} />
				</Tag>
			);
		}
		case "paragraph":
			return (
				<p className={cn(TEXT, tight ? "m-0" : "mt-0 mb-3")}>
					<Inlines inlines={block.children} where={where} />
				</p>
			);
		case "code":
			return <CodeBlock lang={block.lang} text={block.text} />;
		case "rule":
			return <hr className="my-5 border-0 border-t border-border" />;
		case "quote":
			return (
				<blockquote className={cn(TEXT, "mx-0 mt-0 mb-3 border-l-3 border-border-strong pl-4 text-muted-foreground")}>
					<Blocks blocks={block.children} where={where} />
				</blockquote>
			);
		case "list": {
			// A list whose items are each a line is tight: no room between them.
			const tightList = block.items.every((item) => item.filter((each) => each.kind === "paragraph").length <= 1);
			const items = block.items.map((item, index) => (
				<li key={index} className={cn("mt-1 first:mt-0", isTask(item) && "list-none")}>
					<Blocks blocks={item} where={where} tight={tightList} />
				</li>
			));
			return block.ordered ? (
				<ol
					className={cn(TEXT, "mt-0 mb-3 list-decimal pl-6 [&_ol,&_ul]:mt-1 [&_ol,&_ul]:mb-0")}
					start={block.start === 1 ? undefined : block.start}
				>
					{items}
				</ol>
			) : (
				<ul className={cn(TEXT, "mt-0 mb-3 list-disc pl-6 [&_ol,&_ul]:mt-1 [&_ol,&_ul]:mb-0")}>{items}</ul>
			);
		}
		case "table": {
			const align = (index: number) => {
				const to = block.align[index];
				return to === "center" ? "text-center" : to === "right" ? "text-right" : "text-left";
			};
			return (
				<div className="mt-0 mb-3 max-w-full overflow-x-auto">
					<table className="border-collapse text-ui wrap-normal [&_code]:wrap-normal">
						<thead>
							<tr>
								{block.head.map((cell, index) => (
									<th
										key={index}
										className={cn("border border-border bg-surface-2 px-3 py-1.5 font-semibold", align(index))}
									>
										<Inlines inlines={cell} where={where} />
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.map((cell, index) => (
										<td key={index} className={cn("border border-border px-3 py-1.5 align-top", align(index))}>
											<Inlines inlines={cell} where={where} />
										</td>
									))}
									{/* The cells a short row lacks, as one empty cell across them. */}
									{row.length < block.head.length ? (
										<td colSpan={block.head.length - row.length} className="border border-border" />
									) : null}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		}
	}
}

/** Whether a list item is a task list's: its box first in its paragraph. */
const isTask = (item: Block[]) => item[0]?.kind === "paragraph" && item[0].children[0]?.kind === "task";

/** A Markdown file, formatted: its links underlined as in any running text (`prose`). */
export function Markdown({ fallback = null, ...props }: MarkdownProps) {
	return (
		<FormatBoundary source={props.source} fallback={fallback}>
			<Formatted {...props} />
		</FormatBoundary>
	);
}

function Formatted({ source, repo, dir, gitRef, className }: Omit<MarkdownProps, "fallback">) {
	// Read once for each text, not again each time a poll draws the page.
	const blocks = useMemo(() => parseMarkdown(source), [source]);
	return (
		<div className={cn("prose min-w-0 text-body wrap-anywhere", className)} data-markdown="">
			<Blocks blocks={blocks} where={{ repo, dir, ref: gitRef }} />
		</div>
	);
}

interface FormatBoundaryProps {
	source: string;
	fallback: ReactNode;
	children: ReactNode;
}

/**
 * Keeps a file that can't be drawn (something in it nothing expected) to itself: its fallback shows instead, and the
 * rest of the page, Source among it, goes on working. Another text tries again.
 */
export class FormatBoundary extends Component<FormatBoundaryProps, { source: string; failed: boolean }> {
	state = { source: this.props.source, failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	static getDerivedStateFromProps(props: FormatBoundaryProps, state: { source: string }) {
		return props.source === state.source ? null : { source: props.source, failed: false };
	}

	componentDidCatch(error: Error, _info: ErrorInfo) {
		console.error("Unable to format this Markdown", error);
	}

	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}
