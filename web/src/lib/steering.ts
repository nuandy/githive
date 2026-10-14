import type { SteeringFlag } from "../api";

// Text Clef flags as steering the agents who read it (the server's src/steering.ts), in the dashboard's words. A flag
// holds nothing up: it asks a person to look before the change lands.

/** The kinds of text flagged, each once: "intent", "intent and review evidence". */
export function steeringTexts(flags: SteeringFlag[]): string {
	const kinds = [...new Set(flags.map((flag) => flag.in))];
	if (kinds.length < 2) return kinds[0] ?? "text";
	return `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}`;
}

/** One flag in words: "review evidence by ana/claude". */
export function flagWords(flag: SteeringFlag): string {
	return flag.by ? `${flag.in} by ${flag.by}` : flag.in;
}
