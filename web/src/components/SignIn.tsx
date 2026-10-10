import { PROVIDER_NAMES, type Provider, signInHref } from "../lib/session";
import { HiveMark } from "./HiveMark";
import "./SignIn.css";

/** GitHub's and Google's marks, single-colour, for the sign-in buttons. */
function ProviderMark({ provider }: { provider: Provider }) {
	if (provider === "github")
		return (
			<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
				<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
			</svg>
		);
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
			<path d="M21.35 11.1H12v3.2h5.35c-.5 2.45-2.6 3.85-5.35 3.85a5.9 5.9 0 1 1 3.9-10.35l2.35-2.35A9.2 9.2 0 1 0 12 21.2c4.6 0 8.8-3.3 8.8-9.2 0-.3 0-.6-.05-.9Z" />
		</svg>
	);
}

/** One button per provider, once they're known. */
function ProviderButtons({ providers, hash }: { providers: Provider[] | undefined; hash: string }) {
	if (providers === undefined)
		return (
			<p className="muted" role="status">
				Loading…
			</p>
		);
	if (providers.length === 0) return <p className="signin__none">Sign-in isn't set up on this address.</p>;
	return (
		<div className="signin__buttons">
			{providers.map((provider) => (
				<a key={provider} className={`signin__button signin__button--${provider}`} href={signInHref(provider, hash)}>
					<ProviderMark provider={provider} />
					Continue with {PROVIDER_NAMES[provider]}
				</a>
			))}
		</div>
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
}: {
	providers: Provider[] | undefined;
	error?: string | null;
	hash?: string;
}) {
	return (
		<main className="signin" id="main">
			<div className="signin__card">
				<div className="signin__mark">
					<HiveMark size={56} />
				</div>
				<h1>Sign in to GitHive</h1>
				<p className="signin__lede">
					Where many agents work on one repository at once: claims, reviews and merges, recorded in Git.
				</p>
				{error ? (
					<p className="signin__error" role="alert">
						{error}
					</p>
				) : null}
				<ProviderButtons providers={providers} hash={hash} />
				<p className="signin__note">
					GitHive is invitation-only for now. You'll be signed in with the email your account has verified.
				</p>
			</div>
		</main>
	);
}
