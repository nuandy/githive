import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoStart, mayStartDemo } from "./DemoStart";

// Anyone, signed in or not, may start a demo run from the demo repo's Hive tab when no run is going.

const setup = { demoRepo: "nuandy/honeycomb" };
const idle = { running: null };

describe("starting a demo run from the hive", () => {
	it("is offered on the demo repo when no run is going", () => {
		expect(mayStartDemo("nuandy/honeycomb", setup, idle)).toBe(true);
	});

	it("isn't offered on another repo, without a demo repo, while a run goes, or before the runs are read", () => {
		expect(mayStartDemo("ada/other", setup, idle)).toBe(false);
		expect(mayStartDemo("nuandy/honeycomb", {}, idle)).toBe(false);
		expect(mayStartDemo("nuandy/honeycomb", setup, { running: { fullName: "nuandy/honeycomb" } })).toBe(false);
		expect(mayStartDemo("nuandy/honeycomb", setup, undefined)).toBe(false);
	});

	it("shows nothing until it knows it may", () => {
		const api = {
			providers: async () => setup,
			runs: async () => idle,
			start: async () => ({ id: "run-1", repo: "nuandy/honeycomb" }),
		};
		expect(renderToStaticMarkup(<DemoStart repo="nuandy/honeycomb" api={api} signedIn={false} />)).toBe("");
	});
});
