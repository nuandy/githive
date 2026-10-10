/** A count with its noun: "1 file", "3 files". */
export const counted = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
