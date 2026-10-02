import type { SliceLanesProps } from "../dashboard-contract";
import { getSliceStage } from "../lib/dashboardData";
import { formatRelativeTime } from "../lib/relativeTime";
import "./SliceLanes.css";

const stageLabels = { building: "Building", "in-review": "In review", gate: "Gate", integrated: "Integrated", "needs-human": "Needs a human" } as const;

function toneForStage(stage: keyof typeof stageLabels) {
  if (stage === "integrated") return "good";
  if (stage === "needs-human") return "bad";
  if (stage === "gate" || stage === "in-review") return "warn";
  return "accent";
}

export function SliceLanes({ live }: SliceLanesProps) {
  const { task, agents } = live;
  const slices = Array.isArray(task.slices) ? task.slices : [];
  const verify = Array.isArray(task.verify) ? task.verify : [];
  const safeAgents = Array.isArray(agents) ? agents : [];
  return (
    <section className="slice-lanes" aria-labelledby="slice-lanes-title">
      <div className="slice-lanes__heading">
        <h2 id="slice-lanes-title">Slice lanes</h2>
        <span className="muted">{slices.length} {slices.length === 1 ? "slice" : "slices"}</span>
      </div>
      {slices.length === 0 ? <p className="card muted">No slices in this plan.</p> : null}
      <div className="slice-lanes__list">
        {slices.map((slice) => {
          const stageInfo = getSliceStage(slice);
          const sliceAgents = safeAgents.find((agent) => agent?.id === slice.id);
          const builder = sliceAgents?.builder;
          const latestLog = (Array.isArray(builder?.log) ? builder.log : []).slice().sort((a, b) => (b?.at ?? "").localeCompare(a?.at ?? ""))[0];
          const reviews = Array.isArray(slice.reviews) ? slice.reviews : [];
          const owns = Array.isArray(slice.owns) ? slice.owns : [];
          const currentReviews = slice.reviewHead ? reviews.filter((review) => review.head === slice.reviewHead) : [];
          const gate = slice.gate;
          const result = gate?.result;
          const results = Array.isArray(result?.results) ? result.results : [];
          const checks = [
            ...verify.map((command) => ({ command, check: results.find((item) => item.command === command) })),
            ...results.filter((item) => !verify.includes(item.command)).map((check) => ({ command: check.command, check })),
          ];
          return (
            <article className="slice-lane card" key={slice.id}>
              <header className="slice-lane__header">
                <div className="slice-lane__title">
                  <h3>{slice.title}</h3>
                  <span className="muted">{slice.id}</span>
                </div>
                <span className={`badge ${toneForStage(stageInfo.stage)}`}>{stageLabels[stageInfo.stage]} · {stageInfo.revisions} {stageInfo.revisions === 1 ? "revision" : "revisions"}</span>
              </header>

              <section className="slice-lane__section">
                <h4>Owned paths</h4>
                <div className="slice-lane__chips">{owns.length ? owns.map((path) => <code className="slice-lane__chip" key={path}>{path}</code>) : <span className="muted">No paths listed</span>}</div>
              </section>

              <section className="slice-lane__section">
                <h4>Builder</h4>
                <p>{slice.buildSummary || builder?.summary || <span className="muted">No builder summary yet.</span>}</p>
                {latestLog ? <p className="slice-lane__latest"><span className="muted">Latest activity: </span>{latestLog.event} <time dateTime={latestLog.at} title={latestLog.at}>{formatRelativeTime(latestLog.at)}</time></p> : null}
                <p className="muted">{builder ? `${builder.pushes ?? 0} pushes · ${builder.status}` : "Builder not started"}</p>
                {slice.attention ? <p className="error">Needs a human: {slice.attention}</p> : null}
              </section>

              <section className="slice-lane__section">
                <h4>Review{slice.reviewHead ? <span className="slice-lane__commit"> · commit <code>{slice.reviewHead}</code></span> : null}</h4>
                {currentReviews.length ? (
                  <ul className="slice-lane__reviews">
                    {currentReviews.map((review, index) => (
                      <li className="slice-lane__review" key={`${review.reviewer}-${review.head}-${index}`}>
                        <div className="slice-lane__review-top">
                          <strong>{review.reviewer}</strong>
                          <span className={`badge ${review.verdict === "approve" ? "good" : "bad"}`}>{review.verdict}</span>
                        </div>
                        <p>{review.summary}</p>
                        {review.evidence ? <details><summary>Evidence</summary><pre>{review.evidence}</pre></details> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted">{slice.reviewHead ? "No votes on this review commit yet." : "No commit submitted for review."}</p>}
              </section>

              <section className="slice-lane__section">
                <h4>Integration gate</h4>
                {gate ? <p><span className="muted">Status: </span>{gate.status}{gate.at ? <> · <time dateTime={gate.at} title={gate.at}>{formatRelativeTime(gate.at)}</time></> : ""}</p> : <p className="muted">Gate has not run.</p>}
                {result?.mergeConflict?.length ? <p className="error">Merge conflicts: {result.mergeConflict.join(", ")}</p> : null}
                {checks.length ? (
                  <ul className="slice-lane__checks">
                    {checks.map(({ command, check }, index) => (
                      <li key={`${command}-${index}`}>
                        <div className="slice-lane__check-head">
                          <code>{command}</code>
                          <span className={`badge ${check ? (check.exitCode === 0 ? "good" : "bad") : "warn"}`}>{check ? `exit ${check.exitCode}` : "pending"}</span>
                        </div>
                        {check ? <details><summary>Output</summary><pre>{check.output || "(no output)"}</pre></details> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {gate?.excluded?.length ? <div className="slice-lane__excluded"><strong>Excluded tests</strong><ul>{gate.excluded.map((test) => <li key={test}><code>{test}</code></li>)}</ul></div> : null}
              </section>
            </article>
          );
        })}
      </div>
    </section>
  );
}
