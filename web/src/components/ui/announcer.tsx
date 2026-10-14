// A page's live region: what useAnnouncer last said, heard by a screen reader and seen by no one.

export function Announcer({ said }: { said: string }) {
	return (
		<p data-slot="announcer" className="sr-only" aria-live="polite">
			{said}
		</p>
	);
}
