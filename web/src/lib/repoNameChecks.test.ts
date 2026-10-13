import { describe, expect, it } from "vitest";
import { repoNameProblem, repoNameTyping } from "./orgs";

// A new repository's name, checked as it's typed and again once it's left.

describe("a repo's name as it's typed", () => {
	it("names the first character it can't have, with a name to use instead", () => {
		expect(repoNameTyping("my project")).toBe("Spaces aren't allowed. Use my-project?");
		expect(repoNameTyping("my/project")).toBe("Slashes aren't allowed. Use my-project?");
		expect(repoNameTyping("my project! 2")).toBe("Spaces aren't allowed. Use my-project-2?");
		expect(repoNameTyping("café")).toBe("“é” isn't allowed. Use cafe?");
		expect(repoNameTyping("a--b")).toBe("No two dashes in a row. Use a-b?");
		expect(repoNameTyping("-web")).toBe("It can't start with a dash. Use web?");
	});

	it("offers no name while one is still being typed after a bad character, but says what to use", () => {
		expect(repoNameTyping("my ")).toBe("Spaces aren't allowed. Use dashes instead.");
		expect(repoNameTyping("a--")).toBe("No two dashes in a row.");
		expect(repoNameTyping("-")).toBe("It can't start with a dash.");
		expect(repoNameTyping("???")).toBe("“?” isn't allowed. Use letters, digits, dots, underscores and dashes.");
	});

	it("waits for the field to be left before a length, or a name that's only dots", () => {
		expect(repoNameTyping("web-")).toBeNull();
		expect(repoNameTyping(".")).toBeNull();
		expect(repoNameTyping("x".repeat(101))).toBeNull();
		expect(repoNameTyping("my-project.v2_x")).toBeNull();
		expect(repoNameTyping("")).toBeNull();
	});
});

describe("a repo's name once it's left", () => {
	it("says everything wrong with it, the characters as they were said while typing", () => {
		expect(repoNameProblem("")).toBe("Give it a name.");
		expect(repoNameProblem("my project")).toBe("Spaces aren't allowed. Use my-project?");
		expect(repoNameProblem("x".repeat(104))).toBe("Up to 100 characters: this one has 104.");
		expect(repoNameProblem("..")).toBe("“..” can't be a name. Add a letter or a digit.");
		expect(repoNameProblem("web-")).toBeNull();
	});
});
