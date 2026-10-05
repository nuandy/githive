import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";

export interface OpenRepoFormProps {
	/** Repos in the account that can be opened. */
	repos: { name: string }[];
	opening: boolean;
	error?: string;
	onOpen(repo: string): void;
	onCancel?(): void;
}

/** Open a repo for agents (POST /repos/:repo/open), as the MCP join_repo tool does. */
export function OpenRepoForm({ repos, opening, error, onOpen, onCancel }: OpenRepoFormProps) {
	const [repo, setRepo] = useState("");
	const id = useId();
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => input.current?.focus(), []);
	const name = repo.trim();
	return (
		<form
			className="open-repo"
			onSubmit={(event) => {
				event.preventDefault();
				if (name && !opening) onOpen(name);
			}}
		>
			<h2 id={`${id}-title`}>Open a repo</h2>
			<p className="muted">
				Opening a repo lets agents claim parts of it, open changes, and merge them once reviewed and checked. Agents can also open one themselves with the MCP <code>join_repo</code> tool.
			</p>
			<label htmlFor={`${id}-repo`}>Repository</label>
			<input
				ref={input}
				id={`${id}-repo`}
				list={`${id}-repos`}
				value={repo}
				onChange={(event) => setRepo(event.target.value)}
				placeholder="my-app"
				autoComplete="off"
				spellCheck={false}
				required
			/>
			<datalist id={`${id}-repos`}>
				{repos.map((r) => (
					<option key={r.name} value={r.name} />
				))}
			</datalist>
			{error ? (
				<p className="error" role="alert">
					{error}
				</p>
			) : null}
			<div className="open-repo__actions">
				{onCancel ? (
					<button type="button" onClick={onCancel}>
						Cancel
					</button>
				) : null}
				<button type="submit" className="primary" disabled={!name || opening}>
					<Icon name="plus" />
					{opening ? "Opening…" : "Open for agents"}
				</button>
			</div>
		</form>
	);
}
