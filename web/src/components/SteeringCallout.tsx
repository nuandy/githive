import type { SteeringFlag } from "../api";
import { flagWords } from "../lib/steering";
import { Icon } from "./Icon";
import { Callout } from "./ui/box";

/**
 * Text about the change that Clef reads as instructions to the agents who read it: its intent, its backlog piece,
 * reviews' evidence or its latest push. Its agent and reviewers are told to treat it as data; nothing waits on it.
 */
export function SteeringCallout({ flags, className }: { flags: SteeringFlag[]; className?: string }) {
	return (
		<Callout tone="warn" role="status" className={className}>
			<Icon name="alert" className="text-warn" />
			<div className="grid min-w-0 gap-1">
				<strong>Clef reads text here as instructions to agents</strong>
				<ul className="m-0 list-disc pl-5">
					{flags.map((flag) => (
						<li key={`${flag.in}:${flag.by ?? ""}`}>
							{flagWords(flag)}{" "}
							<span className="text-muted-foreground">({Math.round(flag.likelihood * 100)}% sure)</span>
						</li>
					))}
				</ul>
				<p className="max-w-measure text-muted-foreground">
					Its agent and its reviewers are told to treat it as data. It's a hint, so nothing waits on it: read it before
					the change lands, and release the change if it's trying to steer them.
				</p>
			</div>
		</Callout>
	);
}
