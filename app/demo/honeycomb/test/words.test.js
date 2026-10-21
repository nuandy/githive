import assert from "node:assert/strict";
import { test } from "node:test";
import { WORDS } from "../src/words.js";

test("every word is playable: four or more lowercase letters, no s, at most seven different letters", () => {
	assert.ok(WORDS.length > 10_000);
	for (const word of WORDS) {
		assert.match(word, /^[a-rt-z]{4,}$/, word);
		assert.ok(new Set(word).size <= 7, word);
	}
});

test("the words are sorted and appear once each", () => {
	assert.deepEqual(WORDS, [...new Set(WORDS)].sort());
});
