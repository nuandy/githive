import { Icon } from "./Icon";
import { Callout } from "./ui/box";
import { Button } from "./ui/button";

/** What couldn't be loaded and why, in place of it, with a way to try again. */
export function LoadError({
	what,
	error,
	onRetry,
	className,
}: {
	/** What it is, to start the sentence: "The audit". */
	what: string;
	/** Why, in the server's words. */
	error: string;
	onRetry?: () => void;
	className?: string;
}) {
	// The server's words end the sentence, with one full stop whether or not they brought their own.
	const reason = error.trim().replace(/\.$/, "");
	return (
		<Callout tone="bad" role="alert" className={className}>
			<Icon name="x" className="text-bad" />
			{/* The sentence sits level with the icon, as in any callout; the button, a little taller, centers on its line. */}
			<div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-2">
				<span>
					{what} couldn't be loaded: {reason}.
				</span>
				{onRetry ? (
					<Button size="sm" className="-my-0.5 flex-none" onClick={onRetry}>
						Try again
					</Button>
				) : null}
			</div>
		</Callout>
	);
}
