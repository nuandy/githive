import { Fragment, type ReactNode } from "react";
import { languageOf } from "../lib/highlight";
import { type Block, type Inline, linkTarget, parseMarkdown } from "../lib/markdown";
import { cn } from "../lib/utils";
import { TokenLine, useHighlighted } from "./Highlighted";

// A Markdown file as formatted text (lib/markdown.ts reads it): React elements only, so nothing in the file reaches
// the page as HTML. Links go where linkTarget lets them, or show as their words.

export interface MarkdownProps {
	source: string;
	/** Where the file is: its repo, its folder, and the ref it's read at, for its relative links. */
	repo: string;
	dir: string;
	gitRef?: string;
	className?: string;
}

type Where = Pick<MarkdownProps, "repo" | "dir"> & { ref: string | undefined };

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
			const Tag = `h${Math.min(block.level, 6)}` as "h1";
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
				<li key={index} className="mt-1 first:mt-0">
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
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		}
	}
}

/** A Markdown file, formatted: its links underlined as in any running text (`prose`). */
export function Markdown({ source, repo, dir, gitRef, className }: MarkdownProps) {
	return (
		<div className={cn("prose min-w-0 text-body wrap-anywhere", className)} data-markdown="">
			<Blocks blocks={parseMarkdown(source)} where={{ repo, dir, ref: gitRef }} />
		</div>
	);
}
