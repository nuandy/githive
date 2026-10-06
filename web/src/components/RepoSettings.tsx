import { useEffect, useRef, useState } from "react";
import type { SavedSettings, SettingsInput, Task } from "../api";
import { newestChecks } from "../lib/conflicts";
import { changesOf, isActive } from "../lib/model";
import { timeAgo } from "../lib/relativeTime";
import { DEFAULT_EXTERNAL_WAIT_MINUTES, describePolicy, draftFromSettings, draftRoles, removeRole, ROLE, settingsFromDraft, type SettingsDraft } from "../lib/settings";
import { Icon } from "./Icon";
import "./RepoSettings.css";

export interface SettingsApi {
	updateSettings(taskId: string, settings: SettingsInput): Promise<SavedSettings>;
}

const CHECK_WORDS: Record<string, string> = { clean: "merge cleanly", disjoint: "touch different files", conflict: "conflict" };

function currentSettings(task: Task) {
	return { review: task.review, verify: task.verify, leaseMinutes: task.leaseMinutes };
}

/** The Settings tab of an elected repo: its review policy, checks and claim expiry, editable. */
export function RepoSettings({ task, api, onSaved }: { task: Task; api: SettingsApi; onSaved?(): void }) {
	const fresh = draftFromSettings(currentSettings(task));
	const freshKey = JSON.stringify(fresh);
	const [draft, setDraft] = useState<SettingsDraft>(fresh);
	const [baseKey, setBaseKey] = useState(freshKey);
	const [newRole, setNewRole] = useState("");
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const [saved, setSaved] = useState<SavedSettings | null>(null);
	const dirty = JSON.stringify(draft) !== baseKey;

	// Someone else changed the settings: follow them, unless this form has edits of its own.
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	useEffect(() => {
		if (dirtyRef.current) return;
		setDraft(JSON.parse(freshKey) as SettingsDraft);
		setBaseKey(freshKey);
	}, [freshKey]);

	const update = (patch: Partial<SettingsDraft>) => {
		setSaved(null);
		setDraft((current) => ({ ...current, ...patch }));
	};
	const toggle = (list: "vetoes" | "external", role: string, on: boolean) =>
		update({ [list]: on ? [...new Set([...draft[list], role])] : draft[list].filter((r) => r !== role) } as Partial<SettingsDraft>);
	const addRole = () => {
		const role = newRole.trim().toLowerCase();
		if (!role) return;
		if (!ROLE.test(role)) {
			setErrors([`"${role}" isn't a role name: use lowercase words joined by hyphens, like "security" or "api-design".`]);
			return;
		}
		if (!draft.reviewers.includes(role)) update({ reviewers: [...draft.reviewers, role] });
		setNewRole("");
		setErrors([]);
	};
	const extraRoles = draftRoles(draft).filter((r) => !draft.reviewers.includes(r));

	const active = new Set(changesOf(task).filter(isActive).map((change) => change.id));
	const pairs = newestChecks(task).filter((check) => check.pair.every((id) => id === "base" || active.has(id)));
	const branch = task.branch ?? "main";
	const name = (id: string) => (id === "base" ? branch : id);

	return (
		<div className="repo-settings">
			<form
				className="repo-settings__form"
				onSubmit={async (event) => {
					event.preventDefault();
					const result = settingsFromDraft(draft);
					if (!result.settings) {
						setErrors(result.errors);
						return;
					}
					setBusy(true);
					setErrors([]);
					try {
						const savedSettings = await api.updateSettings(task.id, result.settings);
						const next = draftFromSettings(savedSettings);
						setDraft(next);
						setBaseKey(JSON.stringify(next));
						setSaved(savedSettings);
						onSaved?.();
					} catch (error) {
						setErrors([error instanceof Error ? error.message : String(error)]);
					} finally {
						setBusy(false);
					}
				}}
			>
				<p className="callout repo-settings__intro">
					<Icon name="alert" className="muted" />
					<span>
						Changes here apply to reviews that start after you save. A change already in review keeps the rules it went to review under.
					</span>
				</p>

				<section className="box" aria-labelledby="settings-review">
					<div className="box__header">
						<h2 id="settings-review">Review policy</h2>
					</div>
					<div className="box__body repo-settings__fields">
						<div className="repo-settings__field">
							<label htmlFor="settings-required">Required approvals</label>
							<input id="settings-required" type="number" min={0} max={draft.reviewers.length} inputMode="numeric" value={draft.required} onChange={(e) => update({ required: e.target.value })} disabled={busy} />
							<p className="muted">0 merges a change on its checks alone (a role that can block must still approve).</p>
						</div>

						<fieldset className="repo-settings__roles" disabled={busy}>
							<legend>Reviewer roles</legend>
							{draft.reviewers.length ? (
								<div className="repo-settings__table-wrap">
									<table className="repo-settings__table">
										<thead>
											<tr>
												<th scope="col">Role</th>
												<th scope="col">Can block</th>
												<th scope="col">Outside agents review</th>
												<th scope="col">
													<span className="sr-only">Remove</span>
												</th>
											</tr>
										</thead>
										<tbody>
											{draft.reviewers.map((role) => (
												<tr key={role}>
													<th scope="row">
														<code>{role}</code>
													</th>
													<td>
														<input type="checkbox" aria-label={`${role} can block a change`} checked={draft.vetoes.includes(role)} onChange={(e) => toggle("vetoes", role, e.target.checked)} />
													</td>
													<td>
														<input type="checkbox" aria-label={`Outside agents review ${role}`} checked={draft.external.includes(role)} onChange={(e) => toggle("external", role, e.target.checked)} />
													</td>
													<td>
														<button type="button" className="link" onClick={() => update(removeRole(draft, role))} aria-label={`Remove the ${role} role`}>
															Remove
														</button>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							) : (
								<p className="muted">No reviewers: changes merge on their checks alone.</p>
							)}
							<div className="repo-settings__add">
								<label className="sr-only" htmlFor="settings-new-role">
									New role
								</label>
								<input
									id="settings-new-role"
									value={newRole}
									onChange={(e) => setNewRole(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											addRole();
										}
									}}
									placeholder="e.g. security"
									autoComplete="off"
								/>
								<button type="button" onClick={addRole}>
									<Icon name="plus" />
									Add role
								</button>
							</div>
						</fieldset>

						<div className="repo-settings__field">
							<label htmlFor="settings-wait">Wait for outside reviewers (minutes)</label>
							<input
								id="settings-wait"
								type="number"
								min={5}
								max={1440}
								inputMode="numeric"
								value={draft.externalWaitMinutes}
								placeholder={String(DEFAULT_EXTERNAL_WAIT_MINUTES)}
								onChange={(e) => update({ externalWaitMinutes: e.target.value })}
								disabled={busy}
							/>
							<p className="muted">How long a change waits for an outside agent's review before it asks you. Blank: {DEFAULT_EXTERNAL_WAIT_MINUTES}.</p>
						</div>
					</div>
				</section>

				<section className="box" aria-labelledby="settings-escalate">
					<div className="box__header">
						<h2 id="settings-escalate">Stricter rules for paths</h2>
					</div>
					<div className="box__body repo-settings__fields">
						<p className="muted">A change touching any of these paths also needs these roles, and at least this many approvals.</p>
						{draft.escalate.map((row, index) => {
							const set = (patch: Partial<typeof row>) => update({ escalate: draft.escalate.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
							return (
								<fieldset key={index} className="repo-settings__rule" disabled={busy}>
									<legend>Rule {index + 1}</legend>
									<div className="repo-settings__field">
										<label htmlFor={`rule-${index}-paths`}>Paths</label>
										<textarea id={`rule-${index}-paths`} rows={2} value={row.paths} onChange={(e) => set({ paths: e.target.value })} placeholder={"package.json\n.github/"} />
									</div>
									<div className="repo-settings__rule-grid">
										<div className="repo-settings__field">
											<label htmlFor={`rule-${index}-roles`}>Extra roles</label>
											<input id={`rule-${index}-roles`} value={row.reviewers} onChange={(e) => set({ reviewers: e.target.value })} placeholder="security" />
										</div>
										<div className="repo-settings__field">
											<label htmlFor={`rule-${index}-required`}>Approvals</label>
											<input id={`rule-${index}-required`} type="number" min={0} inputMode="numeric" value={row.required} onChange={(e) => set({ required: e.target.value })} placeholder="same" />
										</div>
										<div className="repo-settings__field">
											<label htmlFor={`rule-${index}-vetoes`}>Can block</label>
											<input id={`rule-${index}-vetoes`} value={row.vetoes} onChange={(e) => set({ vetoes: e.target.value })} placeholder="security" />
										</div>
									</div>
									<button type="button" className="link repo-settings__remove" onClick={() => update({ escalate: draft.escalate.filter((_, i) => i !== index) })}>
										Remove rule {index + 1}
									</button>
								</fieldset>
							);
						})}
						<div>
							<button type="button" onClick={() => update({ escalate: [...draft.escalate, { paths: "", reviewers: "", required: "", vetoes: "" }] })} disabled={busy}>
								<Icon name="plus" />
								Add a rule
							</button>
						</div>
						{extraRoles.length ? (
							<fieldset className="repo-settings__extra" disabled={busy}>
								<legend>Roles only these rules add: who reviews them</legend>
								{extraRoles.map((role) => (
									<label key={role} className="repo-settings__check">
										<input type="checkbox" checked={draft.external.includes(role)} onChange={(e) => toggle("external", role, e.target.checked)} />
										Outside agents review <code>{role}</code>
									</label>
								))}
							</fieldset>
						) : null}
					</div>
				</section>

				<section className="box" aria-labelledby="settings-checks">
					<div className="box__header">
						<h2 id="settings-checks">Merge checks</h2>
					</div>
					<div className="box__body repo-settings__fields">
						<p className="muted">Commands that must pass on a change combined with {branch} before it merges. None: a change merges once approved.</p>
						{draft.verify.map((command, index) => (
							<div key={index} className="repo-settings__add">
								<label className="sr-only" htmlFor={`check-${index}`}>
									Check {index + 1}
								</label>
								<input
									id={`check-${index}`}
									className="repo-settings__command"
									value={command}
									onChange={(e) => update({ verify: draft.verify.map((c, i) => (i === index ? e.target.value : c)) })}
									placeholder="npm test"
									spellCheck={false}
									disabled={busy}
								/>
								<button type="button" className="link" onClick={() => update({ verify: draft.verify.filter((_, i) => i !== index) })} disabled={busy} aria-label={`Remove check ${index + 1}`}>
									Remove
								</button>
							</div>
						))}
						<div>
							<button type="button" onClick={() => update({ verify: [...draft.verify, ""] })} disabled={busy}>
								<Icon name="plus" />
								Add a check
							</button>
						</div>
					</div>
				</section>

				<section className="box" aria-labelledby="settings-claims">
					<div className="box__header">
						<h2 id="settings-claims">Claims</h2>
					</div>
					<div className="box__body repo-settings__fields">
						<div className="repo-settings__field">
							<label htmlFor="settings-expiry">Claim expiry (minutes)</label>
							<input id="settings-expiry" type="number" min={5} max={1440} inputMode="numeric" value={draft.leaseMinutes} onChange={(e) => update({ leaseMinutes: e.target.value })} disabled={busy} />
							<p className="muted">A change's claim expires after this long without activity, freeing its paths. From 5 to 1440.</p>
						</div>
					</div>
				</section>

				<div className="repo-settings__save">
					{errors.length ? (
						<ul className="repo-settings__errors" role="alert">
							{errors.map((error) => (
								<li key={error}>{error}</li>
							))}
						</ul>
					) : null}
					{saved ? (
						<p className="tone-good repo-settings__saved" role="status">
							<Icon name="check" /> Saved. {describePolicy(saved.review)}; {saved.verify.length ? `${saved.verify.length} ${saved.verify.length === 1 ? "check" : "checks"}` : "no checks"}; claims expire after {saved.leaseMinutes} minutes.
						</p>
					) : null}
					<div className="repo-settings__buttons">
						<button
							type="button"
							disabled={busy || !dirty}
							onClick={() => {
								setDraft(JSON.parse(freshKey) as SettingsDraft);
								setBaseKey(freshKey);
								setErrors([]);
							}}
						>
							Discard edits
						</button>
						<button type="submit" className="primary" disabled={busy || !dirty}>
							{busy ? "Saving…" : "Save settings"}
						</button>
					</div>
				</div>
			</form>

			<section className="box" aria-labelledby="settings-more">
				<div className="box__header">
					<h2 id="settings-more">How it runs</h2>
				</div>
				<div className="box__body">
					{task.limits ? (
						<p>
							Up to {task.limits.builders} Blueprint {task.limits.builders === 1 ? "builder" : "builders"} and {task.limits.reviewers} {task.limits.reviewers === 1 ? "reviewer" : "reviewers"} run at a time; more wait
							their turn.
						</p>
					) : null}
					<details className="repo-settings__details">
						<summary>Conflict checks between open changes ({pairs.length})</summary>
						<p className="muted">Each push is test-merged with {branch} and with every other open change, so conflicts show up before anything merges.</p>
						{pairs.length ? (
							<ul>
								{pairs.map((check) => (
									<li key={check.pair.join(":")}>
										<code>{name(check.pair[0])}</code> and <code>{name(check.pair[1])}</code>{" "}
										<span className={check.status === "conflict" ? "tone-bad" : "muted"}>{CHECK_WORDS[check.status] ?? check.status}</span>
										{check.status === "conflict" && check.files.length ? <span className="muted"> in {check.files.join(", ")}</span> : null}
										{check.checkedAt ? <span className="muted"> · {timeAgo(check.checkedAt)}</span> : null}
									</li>
								))}
							</ul>
						) : (
							<p className="muted">Nothing checked yet.</p>
						)}
					</details>
				</div>
			</section>
		</div>
	);
}

