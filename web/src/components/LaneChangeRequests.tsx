import type { LaneChangeRequestsProps } from "../dashboard-contract";
import type { LaneChangeRequest } from "../../../src/lane-change-contract";
import "./LaneChangeRequests.css";

const statusLabels: Record<LaneChangeRequest["status"], string> = {
  pending: "Pending",
  answered: "Answered",
  declined: "Declined",
  integrated: "Integrated",
  human: "Human required",
};

function statusTone(status: LaneChangeRequest["status"]): string {
  if (status === "integrated") return "good";
  if (status === "human" || status === "declined") return "bad";
  if (status === "answered") return "accent";
  return "warn";
}

export function LaneChangeRequests({ task }: LaneChangeRequestsProps) {
  const requests = Array.isArray(task.laneChangeRequests) ? task.laneChangeRequests : [];
  return (
    <section className="lane-change-requests card" aria-labelledby="lane-change-requests-title">
      <div className="lane-change-requests__heading">
        <h2 id="lane-change-requests-title">Cross-lane requests</h2>
        <span className="muted">{requests.length} {requests.length === 1 ? "request" : "requests"}</span>
      </div>
      {requests.length === 0 ? <p className="muted">No cross-lane requests.</p> : (
        <ul className="lane-change-requests__list">
          {requests.map((request) => (
            <li className="lane-change-request" key={request.id}>
              <div className="lane-change-request__header">
                <code className="lane-change-request__path">{request.path}</code>
                <span className={`badge ${statusTone(request.status)}`}>{statusLabels[request.status]}</span>
              </div>
              <p className="lane-change-request__slices">
                <span className="muted">Requester: </span><code>{request.requester}</code>
                <span className="lane-change-request__separator" aria-hidden="true">→</span>
                <span className="muted">Owner: </span><code>{request.owner}</code>
              </p>
              <p><strong>Need: </strong>{request.need}</p>
              <p><strong>Reason: </strong>{request.reason}</p>
              {request.answer ? <p className="lane-change-request__answer"><strong>Answer: </strong>{request.answer}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
