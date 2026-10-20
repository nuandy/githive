// The look of the sign-in and consent pages, matching the dashboard's (web/src/styles.css): ink on cool paper,
// ruled rather than boxed, amber and red lamps for notes and warnings.
export const PAGE_STYLE = `
@font-face {
	font-family: "Overpass";
	src: url("/fonts/overpass.woff2") format("woff2");
	font-weight: 100 900;
	font-display: swap;
	unicode-range:
		U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC,
		U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
	font-family: "Overpass Mono";
	src: url("/fonts/overpass-mono.woff2") format("woff2");
	font-weight: 300 700;
	font-display: swap;
	unicode-range:
		U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC,
		U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
	font-family: "Separator";
	src: local("Helvetica Neue"), local("HelveticaNeue"), local("Segoe UI"), local("Arial"), local("Roboto");
	unicode-range: U+00B7;
}
:root {
	--bg: #f5f6f4;
	--surface: #fbfcfb;
	--surface-2: #eef0ee;
	--line: #d3d9d6;
	--line-strong: #b7c0bc;
	--fg: #1e2b33;
	--muted: #56636b;
	--link: #23506e;
	--ink-fill: #1e2b33;
	--on-ink: #f5f6f4;
	--amber: #e59a0b;
	--amber-soft: #fbf0d9;
	--bad: #c03a2b;
	--bad-soft: #f8e4e1;
	--mark-tile: #1e2b33;
	--mark-line: #f5f6f4;
	color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #121a1f;
		--surface: #172127;
		--surface-2: #1d282f;
		--line: #2c3a41;
		--line-strong: #3d4d55;
		--fg: #e4e9e7;
		--muted: #9aa8a6;
		--link: #8cc0e0;
		--ink-fill: #e4e9e7;
		--on-ink: #121a1f;
		--amber: #f2b13a;
		--amber-soft: #33270f;
		--bad: #e5604f;
		--bad-soft: #3a1d1a;
		--mark-tile: #f5f6f4;
		--mark-line: #1e2b33;
	}
}
* {
	box-sizing: border-box;
}
body {
	margin: 0;
	background: var(--bg);
	color: var(--fg);
	font:
		15px/1.55 "Separator",
		"Overpass",
		ui-sans-serif,
		system-ui,
		-apple-system,
		"Segoe UI",
		sans-serif;
	padding: 56px 16px;
}
main {
	max-width: 460px;
	margin: 0 auto;
	display: grid;
	gap: 16px;
}
.brand {
	display: flex;
	align-items: center;
	gap: 10px;
	font-weight: 800;
	font-size: 17px;
	letter-spacing: -0.01em;
	padding-bottom: 14px;
	border-bottom: 2px solid var(--fg);
}
h1 {
	font-size: 22px;
	line-height: 1.25;
	margin: 4px 0 0;
	font-weight: 800;
	letter-spacing: -0.01em;
	text-wrap: balance;
}
p {
	margin: 0;
}
a {
	color: var(--link);
}
.muted {
	color: var(--muted);
}
.warn {
	background: var(--bad-soft);
	border-left: 3px solid var(--bad);
	padding: 10px 12px;
}
.note {
	background: var(--amber-soft);
	border-left: 3px solid var(--amber);
	padding: 10px 12px;
}
fieldset {
	border: 0;
	border-top: 1px solid var(--line);
	padding: 12px 0 0;
	margin: 0;
	display: grid;
	gap: 10px;
}
legend {
	padding: 0 8px 0 0;
	font-weight: 700;
}
label {
	display: flex;
	align-items: center;
	gap: 8px;
}
input[type="radio"] {
	accent-color: var(--ink-fill);
}
input[type="text"],
input[type="url"],
input[type="password"] {
	font: inherit;
	padding: 6px 10px;
	border: 1px solid var(--line-strong);
	border-radius: 4px;
	background: var(--surface);
	color: var(--fg);
	min-width: 0;
	flex: 1;
}
.actions {
	display: flex;
	gap: 10px;
	flex-wrap: wrap;
	padding-top: 4px;
}
button,
.button {
	font: inherit;
	font-weight: 600;
	padding: 8px 16px 7px;
	border-radius: 4px;
	border: 1px solid var(--line-strong);
	background: var(--surface);
	color: var(--fg);
	cursor: pointer;
	text-decoration: none;
	display: inline-block;
}
button.primary,
.button.primary {
	background: var(--ink-fill);
	border-color: var(--ink-fill);
	color: var(--on-ink);
}
button:hover:not(:disabled),
.button:hover {
	background: var(--surface-2);
}
button.primary:hover:not(:disabled),
.button.primary:hover {
	background: color-mix(in srgb, var(--ink-fill) 88%, var(--bg));
}
button:active:not(:disabled),
.button:active {
	transform: translateY(1px);
}
button:disabled {
	cursor: progress;
	opacity: 0.75;
}
button[aria-busy="true"]::before {
	content: "";
	display: inline-block;
	width: 0.8em;
	height: 0.8em;
	margin-right: 8px;
	vertical-align: -0.08em;
	border: 2px solid currentColor;
	border-right-color: transparent;
	border-radius: 50%;
	animation: spin 0.7s linear infinite;
}
@keyframes spin {
	to {
		transform: rotate(360deg);
	}
}
@media (prefers-reduced-motion: reduce) {
	button[aria-busy="true"]::before {
		animation: none;
	}
}
button:focus-visible,
.button:focus-visible,
input:focus-visible {
	outline: 2px solid var(--link);
	outline-offset: 2px;
}
code {
	font-family: "Overpass Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 0.9em;
}
`;
