/** A count with its noun: "1 file", "3 files". */
export const counted = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const WORDS = (
	"zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen " +
	"seventeen eighteen nineteen twenty"
).split(" ");

/** A small count as a word, as prose writes it ("eleven"); past twenty, its digits. */
export const inWords = (count: number) => WORDS[count] ?? String(count);
