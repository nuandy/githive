import { Component, type ErrorInfo, type ReactNode } from "react";

interface TaskDetailBoundaryProps {
  children: ReactNode;
}

interface TaskDetailBoundaryState {
  failed: boolean;
}

/** Keep an unexpected task-specific render failure from taking down the dashboard shell. */
export class TaskDetailBoundary extends Component<TaskDetailBoundaryProps, TaskDetailBoundaryState> {
  state: TaskDetailBoundaryState = { failed: false };

  static getDerivedStateFromError(): TaskDetailBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error("Unable to render task details", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <section className="card" role="alert">
          <h1>Task details unavailable</h1>
          <p>The selected task could not be displayed. The dashboard is still available; select another task or reload to try again.</p>
        </section>
      );
    }
    return this.props.children;
  }
}
