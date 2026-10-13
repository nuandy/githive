import { useState } from "react";
import { useChanged } from "../hooks/useChanged";
import { PROVIDER_NAMES, type Provider, signInHref } from "../lib/session";
import { cn } from "../lib/utils";
import { HiveMark } from "./HiveMark";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/field";

/** GitHub's and Google's marks, single-colour, for the sign-in buttons. */
function ProviderMark({ provider }: { provider: Provider }) {
	if (provider === "github")
		return (
			<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
				<path
					d={
						"M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 " +
						"0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 " +
						"1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 " +
						"0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 " +
						"0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 " +
						"3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 " +
						".21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
					}
				/>
			</svg>
		);
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
			<path
				d={
					"M21.35 11.1H12v3.2h5.35c-.5 2.45-2.6 3.85-5.35 3.85a5.9 5.9 0 1 1 3.9-10.35l2.35-2.35A9.2 9.2 " +
					"0 1 0 12 21.2c4.6 0 8.8-3.3 8.8-9.2 0-.3 0-.6-.05-.9Z"
				}
			/>
		</svg>
	);
}

/** One button per provider, once they're known. */
function ProviderButtons({
	providers,
	hash,
	invite,
}: {
	providers: Provider[] | undefined;
	hash: string;
	invite: string;
}) {
	// What takes the place of "Loading…" fades in.
	const appear = useChanged(providers === undefined) && "animate-fade";
	if (providers === undefined)
		return (
			<p className="my-3.75 text-muted-foreground" role="status">
				Loading…
			</p>
		);
	if (providers.length === 0)
		return <p className={cn("mt-1 mb-0 text-muted-foreground", appear)}>Sign-in isn't set up on this address.</p>;
	return (
		<div className={cn("mt-1.5 grid w-full gap-2.5", appear)}>
			{providers.map((provider, index) => (
				// The first is in ink.
				<Button
					key={provider}
					asChild
					variant={index === 0 ? "primary" : "default"}
					className="gap-2.5 px-4 py-2.5 leading-[inherit] whitespace-normal"
				>
					<a href={signInHref(provider, hash, invite)}>
						<ProviderMark provider={provider} />
						Continue with {PROVIDER_NAMES[provider]}
					</a>
				</Button>
			))}
		</div>
	);
}

// The ground the card sits on: a glow of ink from the top over a faint honeycomb. The comb is an image, so it keeps its
// own honey in both themes.
const GROUND = [
	"radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--primary) 16%, transparent), transparent 60%)",
	`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='98' viewBox='0 0 56 98'%3E%3Cpath d='M28 66 0 50V18L28 2l28 16v32L28 66Zm0 32L0 82V66' fill='none' stroke='%23f2a516' stroke-opacity='0.16' stroke-width='1'/%3E%3C/svg%3E")`,
].join(", ");

const SOURCE = "https://github.com/nuandy/githive";

/** Where to read more before signing in: the code, how it works, how to get in, and what happens to your data. */
function SignInFooter() {
	const links: [string, string][] = [
		["Source on GitHub", SOURCE],
		["How it works", `${SOURCE}#how-it-works`],
		["Ask for an invite", `${SOURCE}#try-it`],
		["Your data", `${SOURCE}/blob/main/docs/operating.md#data-and-security`],
	];
	// A dot between each and the next.
	const item = "not-first:before:mx-2 not-first:before:content-['·']";
	return (
		<footer className="animate-fade">
			<ul className="m-0 flex list-none flex-wrap justify-center gap-x-0 gap-y-1 p-0 text-meta text-muted-foreground">
				{links.map(([label, url]) => (
					<li key={label} className={item}>
						<a
							className="text-muted-foreground transition-colors duration-fast hover:text-foreground"
							href={url}
							target="_blank"
							rel="noreferrer"
						>
							{label}
						</a>
					</li>
				))}
				<li className={item}>MIT license</li>
			</ul>
		</footer>
	);
}

/**
 * The page everyone who isn't signed in sees: who GitHive is for, and one
 * button per provider set up on this address. A failed sign-in comes back here
 * with its reason.
 */
export function SignIn({
	providers,
	error,
	hash = "",
	takesInviteCode = false,
	invite: linkedInvite = "",
}: {
	providers: Provider[] | undefined;
	error?: string | null;
	hash?: string;
	/** An invite code lets people in here, so the screen asks for one. */
	takesInviteCode?: boolean;
	/** The invite code the link carried, filled in. */
	invite?: string;
}) {
	const [invite, setInvite] = useState(linkedInvite);
	return (
		// The card in the middle, the footer at the bottom; both fade in, the ground under them already there.
		<main
			id="main"
			className="grid min-h-dvh grid-rows-[1fr_auto] place-items-center gap-6 bg-background px-4 pt-10 pb-5"
			style={{ backgroundImage: GROUND }}
		>
			<div
				className={cn(
					"grid w-full max-w-100 animate-fade justify-items-center gap-3.5 px-7 pt-9 pb-7 text-center",
					"rounded-3xl border border-border bg-card shadow-raised",
				)}
			>
				<div className="mb-1 grid place-items-center">
					<HiveMark size={56} />
				</div>
				<h1 className="text-title-lg tracking-[-0.01em] text-balance">Sign in to GitHive</h1>
				<p className="m-0 max-w-[32ch] text-muted-foreground">
					A hive for coding agents: no queen assigns the work, each agent claims its own work, and every step is
					recorded in Git.
				</p>
				{error ? (
					<p className="mt-1 mb-0 w-full rounded-md bg-warn-soft px-3 py-2.5 text-left text-warn" role="alert">
						{error}
					</p>
				) : null}
				{takesInviteCode ? (
					<Label className="grid w-full gap-1 text-left text-ui text-muted-foreground">
						<span>Invite code, if you have one</span>
						<Input
							className="w-full font-mono"
							value={invite}
							onChange={(event) => setInvite(event.target.value)}
							autoComplete="off"
							spellCheck={false}
						/>
					</Label>
				) : null}
				<ProviderButtons providers={providers} hash={hash} invite={invite} />
				<p className="mt-2 mb-0 max-w-[34ch] text-meta text-muted-foreground">
					{takesInviteCode
						? "GitHive is invite-only for now. Have an invite code? Enter it, then continue."
						: "GitHive is invite-only for now. If you aren't invited yet, signing in asks an admin to let you in."}
				</p>
			</div>
			<SignInFooter />
		</main>
	);
}
