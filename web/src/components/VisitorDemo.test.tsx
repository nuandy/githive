import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VisitorDemo, visitorMayStart } from "./VisitorDemo";

// A visitor who isn't signed in may start a demo run from the demo repo's Hive tab when no run is going.

const setup = { demoRepo: "nuandy/honeycomb" };
const idle = { running: null };

describe("starting a demo run signed out", () => {
	it("is offered on the demo repo when no run is going", () => {
		expect(visitorMayStart("nuandy/honeycomb", setup, idle)).toBe(true);
	});

	it("isn't offered on another repo, without a demo repo, while a run goes, or before the runs are read", () => {
		expect(visitorMayStart("ada/other", setup, idle)).toBe(false);
		expect(visitorMayStart("nuandy/honeycomb", {}, idle)).toBe(false);
		expect(visitorMayStart("nuandy/honeycomb", setup, { running: { fullName: "nuandy/honeycomb" } })).toBe(false);
		expect(visitorMayStart("nuandy/honeycomb", setup, undefined)).toBe(false);
	});

	it("shows nothing until it knows it may", () => {
		const api = {
			providers: async () => setup,
			runs: async () => idle,
			start: async () => ({ id: "run-1", repo: "nuandy/honeycomb" }),
		};
		expect(renderToStaticMarkup(<VisitorDemo repo="nuandy/honeycomb" api={api} />)).toBe("");
	});
});
