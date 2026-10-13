import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
	it("keeps the theme's text sizes apart from its text colors", () => {
		expect(cn("text-meta text-muted-foreground")).toBe("text-meta text-muted-foreground");
		expect(cn("text-meta", "text-ui")).toBe("text-ui");
		expect(cn("text-link", "text-bad")).toBe("text-bad");
	});

	it("lets a later class win over an earlier one that sets the same thing", () => {
		expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
		expect(cn("duration-fast", "duration-slow")).toBe("duration-slow");
		expect(cn("shadow-raised", "shadow-focus")).toBe("shadow-focus");
		expect(cn("rounded-md", false, undefined, "rounded-full")).toBe("rounded-full");
	});
});
