import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeMenu } from "../ThemeMenu";
import { Badge, Counter, Lamp } from "./badge";
import { Box, BoxHeader, BoxRow, BoxTitle, Callout } from "./box";
import { Button } from "./button";
import { Collapse } from "./collapse";
import { Input, NativeSelect, Textarea } from "./field";
import { SaveBar } from "./save-bar";
import { Segmented } from "./segmented";
import { StatusIcon } from "../StatusPill";
import { AlertDialog, AlertDialogAction, AlertDialogTrigger } from "./alert-dialog";
import { Dialog, DialogTrigger, OVERLAY, PANEL } from "./dialog";
import { Popover, PopoverTrigger } from "./popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { Announcer } from "./announcer";
import { mayAnnounce, SAY_EVERY_MS } from "../../hooks/useAnnouncer";

describe("the building blocks", () => {
	it("draws a plain button that doesn't submit forms", () => {
		const html = renderToStaticMarkup(<Button>Save</Button>);
		expect(html).toContain('type="button"');
		expect(html).toContain('data-slot="button"');
		expect(html).toContain("bg-card");
	});

	it("leaves a button's and a field's focus to the outline everything has", () => {
		for (const html of [renderToStaticMarkup(<Button>Save</Button>), renderToStaticMarkup(<Input />)]) {
			expect(html).not.toContain("outline-none");
			expect(html).not.toContain("focus-visible:border");
		}
	});

	it("lets a later class win over a variant's", () => {
		const html = renderToStaticMarkup(
			<Button variant="go" className="px-6">
				Merge
			</Button>,
		);
		expect(html).toContain("bg-good");
		expect(html).toContain("px-6");
		expect(html).not.toContain("px-3.5");
	});

	it("draws its look on a link instead, when asked", () => {
		const html = renderToStaticMarkup(
			<Button asChild variant="primary">
				<a href="#/new">New repository</a>
			</Button>,
		);
		expect(html).toMatch(/^<a [^>]*href="#\/new"/);
		expect(html).toContain("bg-primary");
		expect(html).not.toContain('type="button"');
	});

	it("has no padding on a link-like button, whatever its size", () => {
		const html = renderToStaticMarkup(
			<Button variant="link" size="sm">
				Remove
			</Button>,
		);
		expect(html).toContain("p-0");
		expect(html).not.toContain("px-2.5");
	});

	it("colors badges by tone, soft or solid", () => {
		expect(renderToStaticMarkup(<Badge tone="good">Approved</Badge>)).toContain("bg-good-soft text-good");
		const solid = renderToStaticMarkup(
			<Badge tone="bad" solid>
				Failed
			</Badge>,
		);
		expect(solid).toContain("bg-bad text-bad-foreground");
		expect(solid).not.toContain("bg-bad-soft");
		expect(renderToStaticMarkup(<Counter>13</Counter>)).toContain(">13<");
	});

	it("lights a lamp in its color, or the one set around it", () => {
		expect(renderToStaticMarkup(<Lamp color="green" />)).toContain("[--lamp:var(--good)]");
		expect(renderToStaticMarkup(<Lamp />)).not.toContain("[--lamp:");
	});

	it("rings the amber lamp in warn on light paper, where amber alone is too pale to see", () => {
		const amber = renderToStaticMarkup(<Lamp color="amber" />);
		expect(amber).toContain("inset-ring-warn");
		expect(amber).toContain("dark:inset-ring-0");
	});

	it("rules boxes and callouts", () => {
		const html = renderToStaticMarkup(
			<Box>
				<BoxHeader>Review policy</BoxHeader>
				<BoxRow>Required approvals</BoxRow>
			</Box>,
		);
		expect(html).toContain('<section data-slot="box"');
		expect(html).toContain("border-t-2");
		expect(renderToStaticMarkup(<Callout tone="needs">Needs a person</Callout>)).toContain("bg-needs-soft");
	});

	it("titles a box's section in one size, an h2 unless asked for another level", () => {
		const html = renderToStaticMarkup(
			<BoxHeader>
				<BoxTitle id="policy-title">Review policy</BoxTitle>
			</BoxHeader>,
		);
		expect(html).toMatch(
			/<h2 data-slot="box-title" class="[^"]*\btext-title-sm\b[^"]*\bfont-semibold\b[^"]*" id="policy-title">/,
		);
		expect(
			renderToStaticMarkup(
				<BoxTitle asChild>
					<h3>Rule 1</h3>
				</BoxTitle>,
			),
		).toMatch(/^<h3 data-slot="box-title"/);
	});

	it("saves at a form's foot: what happened, then Discard and Save, Save in ink", () => {
		const clean = renderToStaticMarkup(<SaveBar dirty={false} onDiscard={() => undefined} status="Settings saved." />);
		expect(clean).toMatch(/<p[^>]*role="status"[^>]*>Settings saved\.<\/p>/);
		expect(clean).toContain("sticky bottom-0");
		const buttons = clean.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
		expect(buttons.map((button) => button.replace(/<[^>]*>/g, ""))).toEqual(["Discard", "Save"]);
		expect(buttons[1]).toContain('type="submit"');
		expect(buttons[1]).toContain("bg-primary");
		for (const button of buttons) expect(button).toContain('disabled=""');

		const busy = renderToStaticMarkup(
			<SaveBar dirty busy onDiscard={() => undefined} saveLabel="Save branch rules" discardLabel="Discard edits" />,
		);
		expect(busy).toContain(">Saving…<");
		expect(busy).toContain(">Discard edits<");
		const editing = renderToStaticMarkup(<SaveBar dirty onDiscard={() => undefined} saveLabel="Save branch rules" />);
		expect(editing).toContain(">Save branch rules<");
		expect(editing).not.toContain('disabled=""');
	});

	it("keeps a closed collapse in the page but out of reach", () => {
		const closed = renderToStaticMarkup(<Collapse open={false}>Details</Collapse>);
		expect(closed).toContain('data-state="closed"');
		expect(closed).toContain("inert");
		expect(closed).toContain("grid-rows-[0fr]");
		const open = renderToStaticMarkup(<Collapse open>Details</Collapse>);
		expect(open).not.toContain("inert");
		expect(open).toContain("grid-rows-[1fr]");
	});

	it("draws fields in the same box, its edge and placeholder at a contrast that shows", () => {
		for (const html of [
			renderToStaticMarkup(<Input defaultValue="2" />),
			renderToStaticMarkup(<Textarea defaultValue="npm test" />),
			renderToStaticMarkup(
				<NativeSelect defaultValue="a">
					<option value="a">A</option>
				</NativeSelect>,
			),
		]) {
			expect(html).toContain("border-input");
			expect(html).toContain("placeholder:text-muted-foreground");
		}
	});

	it("edges every control in the input's color", () => {
		expect(renderToStaticMarkup(<Button>Save</Button>)).toContain("border-input");
		expect(renderToStaticMarkup(<Button variant="danger">Delete</Button>)).toContain("border-input");
		const segmented = renderToStaticMarkup(
			<Segmented label="View" options={[{ value: "a", words: "A" }]} value="a" onPick={() => undefined} />,
		);
		expect(segmented).toMatch(/data-slot="segmented"[^>]*border-input/);
		expect(renderToStaticMarkup(<ThemeMenu />)).toContain("border-input");
	});

	it("gives what's small to tap a 44px target on a touch screen", () => {
		expect(renderToStaticMarkup(<Button size="sm">Edit</Button>)).toContain("touch-target");
		expect(renderToStaticMarkup(<Button size="icon">×</Button>)).toContain("touch-target");
		expect(renderToStaticMarkup(<Button>Save</Button>)).not.toContain("touch-target");
		const segmented = renderToStaticMarkup(
			<Segmented label="View" options={[{ value: "a", words: "A" }]} value="a" onPick={() => undefined} />,
		);
		expect(segmented).toMatch(/<button[^>]*touch-target/);
		expect(renderToStaticMarkup(<ThemeMenu />)).toContain("touch-target");
	});

	it("doesn't clip a focused choice's ring", () => {
		const html = renderToStaticMarkup(
			<Segmented
				label="Window"
				options={[
					{ value: 1, words: "1 h" },
					{ value: 6, words: "6 h" },
				]}
				value={1}
				onPick={() => undefined}
			/>,
		);
		expect(html).not.toMatch(/data-slot="segmented"[^>]*overflow-hidden/);
		expect(html).toContain("focus-visible:outline-2");
		expect(html).not.toContain("focus-visible:outline-none");
	});
});

describe("the announcer", () => {
	it("says what it's given in a polite live region no one sees", () => {
		expect(renderToStaticMarkup(<Announcer said="ada landed Search" />)).toBe(
			'<p data-slot="announcer" class="sr-only" aria-live="polite">ada landed Search</p>',
		);
	});

	it("speaks at most once every few seconds", () => {
		expect(mayAnnounce(0, 1_000)).toBe(false);
		expect(mayAnnounce(0, SAY_EVERY_MS)).toBe(true);
		expect(mayAnnounce(10_000, 12_000)).toBe(false);
		expect(mayAnnounce(10_000, 12_000, 1_000)).toBe(true);
	});
});

describe("overlays", () => {
	it("gives a tooltip its trigger, in the dashboard's provider or a provider of its own", () => {
		const tip = (
			<Tooltip>
				<TooltipTrigger asChild>
					<span tabIndex={0}>Live</span>
				</TooltipTrigger>
				<TooltipContent>Connected</TooltipContent>
			</Tooltip>
		);
		for (const html of [renderToStaticMarkup(tip), renderToStaticMarkup(<TooltipProvider>{tip}</TooltipProvider>)]) {
			expect(html).toMatch(/^<span tabindex="0" data-state="closed" data-slot="tooltip-trigger">Live<\/span>$/);
		}
	});

	it("says a status's words in a tooltip, not a title", () => {
		const html = renderToStaticMarkup(<StatusIcon status={{ kind: "merged", tone: "good", label: "Merged" }} />);
		expect(html).toContain('data-slot="tooltip-trigger"');
		expect(html).toContain('aria-label="Merged"');
		expect(html).not.toContain("title=");
	});

	it("opens a popover from a button that says so", () => {
		const html = renderToStaticMarkup(
			<Popover>
				<PopoverTrigger>Who holds this</PopoverTrigger>
			</Popover>,
		);
		expect(html).toContain('aria-haspopup="dialog"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('data-slot="popover-trigger"');
	});

	it("opens a dialog, or a question, from a button that says so", () => {
		for (const html of [
			renderToStaticMarkup(
				<Dialog>
					<DialogTrigger>New token</DialogTrigger>
				</Dialog>,
			),
			renderToStaticMarkup(
				<AlertDialog>
					<AlertDialogTrigger>Delete</AlertDialogTrigger>
				</AlertDialog>,
			),
		]) {
			expect(html).toContain('aria-haspopup="dialog"');
			expect(html).toContain('data-state="closed"');
		}
	});

	it("goes ahead with a question in red ink, unless told otherwise", () => {
		const danger = renderToStaticMarkup(
			<AlertDialog>
				<AlertDialogAction>Delete</AlertDialogAction>
			</AlertDialog>,
		);
		expect(danger).toContain("text-bad");
		const primary = renderToStaticMarkup(
			<AlertDialog>
				<AlertDialogAction variant="primary">Make public</AlertDialogAction>
			</AlertDialog>,
		);
		expect(primary).toContain("bg-primary");
	});

	it("dims the page behind a dialog and fades the dialog in and out, growing a little", () => {
		for (const fades of ["data-[state=open]:fade-in-0", "data-[state=closed]:fade-out-0"]) {
			expect(OVERLAY).toContain(fades);
			expect(PANEL).toContain(fades);
		}
		expect(PANEL).toContain("data-[state=open]:zoom-in-95");
	});
});

describe("the theme menu", () => {
	it("says what it shows before the reader's choice is known", () => {
		const html = renderToStaticMarkup(<ThemeMenu />);
		expect(html).toContain('aria-label="Theme: same as this device (light)"');
		expect(html).toContain('aria-haspopup="menu"');
	});
});

describe("the dashboard's source", () => {
	// Every file under web/src but the tests, as text.
	const sources = import.meta.glob<string>(["../../**/*.{ts,tsx}", "!../../**/*.test.{ts,tsx}"], {
		query: "?raw",
		import: "default",
		eager: true,
	});

	it("uses no raw colors or system styles: every color comes from theme.css", () => {
		expect(Object.keys(sources).length).toBeGreaterThan(50);
		const offenders = Object.keys(sources).filter((file) =>
			/#[0-9a-f]{6}\b|ThreeDFace|font-family:monospace/i.test(sources[file]!),
		);
		expect(offenders).toEqual([]);
	});

	it("sizes text from the theme's scale, but where the Hive draws its marks", () => {
		// The Hive's map and the goals' chips and clock set type inside shapes of their own size; later work redraws them.
		const marks = ["HiveMap.tsx", "GoalsPanel.tsx", "Territory.tsx"];
		const offenders = Object.keys(sources).filter(
			(file) => !marks.some((mark) => file.endsWith(`/${mark}`)) && /\btext-\[[\d.]+(px|em|rem)\]/.test(sources[file]!),
		);
		expect(offenders).toEqual([]);
	});

	it("grows menus, tooltips and popovers from their trigger, fading both ways", () => {
		for (const [file, part] of [
			["./dropdown-menu.tsx", "dropdown-menu"],
			["./tooltip.tsx", "tooltip"],
			["./popover.tsx", "popover"],
		] as const) {
			const source = sources[file]!;
			expect(source, file).toContain(`origin-(--radix-${part}-content-transform-origin)`);
			expect(source, file).toMatch(/fade-in-0/);
			expect(source, file).toMatch(/data-\[state=closed\]:fade-out-0/);
		}
	});

	it("draws focus one way: the outline, never a border and halo instead", () => {
		const offenders = Object.keys(sources).filter((file) =>
			/shadow-focus|focus-visible:outline-none|focus-visible:border-ring/.test(sources[file]!),
		);
		expect(offenders).toEqual([]);
	});
});
