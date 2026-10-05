import type { MergeAheadMatrixProps } from "../dashboard-contract";
import { buildMergeMatrix } from "../lib/dashboardData";
import { formatRelativeTime } from "../lib/relativeTime";
import "./MergeAheadMatrix.css";

export function MergeAheadMatrix({ task }: MergeAheadMatrixProps) {
  const matrix = buildMergeMatrix(task);
  const slices = Array.isArray(task.slices) ? task.slices : [];
  const label = (id: string) => id === "base" ? "main" : slices.find((slice) => slice.id === id)?.title ?? id;
  return (
    <section className="merge-matrix card" aria-labelledby="merge-matrix-title">
      <div className="merge-matrix__heading">
        <h2 id="merge-matrix-title">Merge-ahead matrix</h2>
        <span className="muted">Latest pair checks</span>
      </div>
      <div className="merge-matrix__scroll" tabIndex={0} aria-label="Scrollable merge-ahead matrix">
        <table>
          <thead>
            <tr><th scope="col">Row / column</th>{matrix.ids.map((id) => <th scope="col" key={id}>{label(id)}</th>)}</tr>
          </thead>
          <tbody>
            {matrix.ids.map((rowId, rowIndex) => (
              <tr key={rowId}>
                <th scope="row">{label(rowId)}</th>
                {(matrix.cells[rowIndex] ?? []).map((cell, columnIndex) => (
                  <td key={`${rowId}-${matrix.ids[columnIndex]}`}>
                    <span className={`merge-matrix__status merge-matrix__status--${cell.status}`}>{cell.status}</span>
                    {cell.files.length ? <ul className="merge-matrix__files">{cell.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : null}
                    {cell.checkedAt ? <time className="merge-matrix__time" dateTime={cell.checkedAt} title={cell.checkedAt}>{formatRelativeTime(cell.checkedAt)}</time> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
