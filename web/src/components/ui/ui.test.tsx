import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeMenu } from "../ThemeMenu";
import { Badge, Counter, Lamp } from "./badge";
import { Box, BoxHeader, BoxRow, Callout } from "./box";
import { Button } from "./button";
import { Collapse } from "./collapse";
import { Input, NativeSelect, Textarea } from "./field";

describe("the building blocks", () => {
	it("draws a plain button that doesn't submit forms", () => {
		const html = renderToStaticMarkup(<Button>Save</Button>);
		expect(html).toContain('type="button"');
		expect(html).toContain('data-slot="button"');
		expect(html).toContain("bg-card");
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

	it("keeps a closed collapse in the page but out of reach", () => {
		const closed = renderToStaticMarkup(<Collapse open={false}>Details</Collapse>);
		expect(closed).toContain('data-state="closed"');
		expect(closed).toContain("inert");
		expect(closed).toContain("grid-rows-[0fr]");
		const open = renderToStaticMarkup(<Collapse open>Details</Collapse>);
		expect(open).not.toContain("inert");
		expect(open).toContain("grid-rows-[1fr]");
	});

	it("draws fields in the same box", () => {
		for (const html of [
			renderToStaticMarkup(<Input defaultValue="2" />),
			renderToStaticMarkup(<Textarea defaultValue="npm test" />),
			renderToStaticMarkup(
				<NativeSelect defaultValue="a">
					<option value="a">A</option>
				</NativeSelect>,
			),
		])
			expect(html).toContain("border-border-strong");
	});
});

describe("the theme menu", () => {
	it("says what it shows before the reader's choice is known", () => {
		const html = renderToStaticMarkup(<ThemeMenu />);
		expect(html).toContain('aria-label="Theme: same as this device (light)"');
		expect(html).toContain('aria-haspopup="menu"');
	});
});
