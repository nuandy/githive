import { useState } from "react";
import type { ActivityFeedProps } from "../dashboard-contract";
import { mergeActivity } from "../lib/dashboardData";
import "./ActivityFeed.css";

export function ActivityFeed({ agents }: ActivityFeedProps) {
  const [includeCommands, setIncludeCommands] = useState(false);
  const activity = mergeActivity(agents, includeCommands);
  return (
    <section className="activity-feed card" aria-labelledby="activity-feed-title">
      <div className="activity-feed__heading">
        <div>
          <h2 id="activity-feed-title">Activity</h2>
          <p className="muted">Builder and reviewer events, newest first</p>
        </div>
        <label className="activity-feed__toggle">
          <input type="checkbox" checked={includeCommands} onChange={(event) => setIncludeCommands(event.target.checked)} />
          Show run commands
        </label>
      </div>
      {activity.length ? (
        <ol className="activity-feed__list">
          {activity.map((item) => (
            <li key={item.id}>
              <span className="activity-feed__agent">{item.agent}</span>
              <span className="activity-feed__slice">{item.sliceId}</span>
              <p>{item.event}</p>
              <time>{item.at}</time>
            </li>
          ))}
        </ol>
      ) : <p className="muted">No activity yet.</p>}
    </section>
  );
}
