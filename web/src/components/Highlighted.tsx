import { useEffect, useState } from "react";
import { highlight, type Token, tokenClass } from "../lib/highlight";

// Code in its syntax colors (lib/highlight.ts): plain at first, colored once highlight.js and the language have
// loaded. Very long files stay plain.

/** The most a file may hold and still be colored: more takes highlight.js too long. */
const MOST_CHARACTERS = 200_000;

/** `text` as lines of tokens in `language`, once highlighted; null while it loads, or if it won't be. */
export function useHighlighted(text: string | undefined, language: string | undefined): Token[][] | null {
	const [shown, setShown] = useState<{ text: string; language: string; lines: Token[][] } | null>(null);
	useEffect(() => {
		if (text === undefined || !language || text.length > MOST_CHARACTERS) return;
		let current = true;
		void highlight(text, language).then((lines) => {
			if (current && lines) setShown({ text, language, lines });
		});
		return () => {
			current = false;
		};
	}, [text, language]);
	return shown && shown.text === text && shown.language === language ? shown.lines : null;
}

/** One line's tokens, each in its scope's color. */
export function TokenLine({ tokens }: { tokens: Token[] }) {
	return (
		<>
			{tokens.map((token, index) => {
				const color = tokenClass(token.scopes);
				return color ? (
					<span key={index} className={color}>
						{token.text}
					</span>
				) : (
					token.text
				);
			})}
		</>
	);
}
