import { describe, expect, it } from "vitest";
import { type Clef, clefOn } from "../src/clef";
import { browserShots, previewHint } from "../src/preview-look";

// A change's site preview, as Clef sees it: Browser Run takes a wide and a narrow screenshot, and Clef says whether the
// page looks broken. A page that looks fine, or that Clef isn't sure of, makes no hint; a screenshot that fails is
// left out, and with none there's nothing to ask.

const SHOT = "data:image/jpeg;base64,/9j/4AAQ";
const URL = "https://githive.app/site/nuandy/honeycomb/@c-9/";

describe("the preview look", () => {
	it("screenshots the preview in a laptop's window and a phone's, leaving out one that fails", async () => {
		const asked: unknown[] = [];
		const browser = {
			quickAction: async (_action: string, options: { viewport: { width: number } }) => {
				asked.push(options);
				if (options.viewport.width < 500) return new Response("too many browsers", { status: 429 });
				return new Response(SHOT, { headers: { "Content-Type": "text/plain" } });
			},
		} as unknown as BrowserRun;
		expect(await browserShots(browser)(URL)).toEqual([SHOT]);
		expect(asked).toMatchObject([
			{ url: URL, viewport: { width: 1280 }, screenshotOptions: { encoding: "base64" } },
			{ url: URL, viewport: { width: 390, isMobile: true } },
		]);
	});

	it("says what looks broken when Clef is sure of it, and nothing otherwise", async () => {
		const answering = (choice: string, likelihood: number): Clef & { images: (string[] | undefined)[] } => {
			const images: (string[] | undefined)[] = [];
			return {
				images,
				ask: async (model, _state, _questions, given) => {
					expect(model).toBe("clef");
					images.push(given);
					return { looks: { type: "choice", choice, probabilities: { [choice]: likelihood }, confidence: 0.6 } };
				},
			};
		};
		const shots = async () => [SHOT, SHOT];
		const blank = answering("blank", 0.86);
		expect(await previewHint(blank, shots, URL)).toEqual({
			kind: "looks_broken",
			says: "Its preview seems to show a blank page",
			likelihood: 0.86,
			url: URL,
		});
		expect(blank.images).toEqual([[SHOT, SHOT]]);
		expect(await previewHint(answering("fine", 0.9), shots, URL)).toBeNull();
		expect(await previewHint(answering("layout", 0.5), shots, URL)).toBeNull();
		const unasked = answering("blank", 0.99);
		expect(await previewHint(unasked, async () => [], URL)).toBeNull();
		expect(unasked.images).toEqual([]);
	});

	it("sends Clef the images with the questions", async () => {
		const runs: unknown[] = [];
		const ai = { run: async (_model: string, input: unknown) => (runs.push(input), { answers: {} }) };
		await clefOn(ai as unknown as Ai).ask("clef", "state", { q: { type: "noul", instructions: "?" } }, [SHOT]);
		expect(runs).toEqual([{ model: "clef", state: "state", questions: { q: expect.any(Object) }, images: [SHOT] }]);
	});
});
