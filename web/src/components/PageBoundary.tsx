import { Component, type ErrorInfo, type ReactNode } from "react";

interface PageBoundaryState {
	failed: boolean;
}

/** Keep an unexpected render failure in one page from taking down the whole dashboard. */
export class PageBoundary extends Component<{ children: ReactNode }, PageBoundaryState> {
	state: PageBoundaryState = { failed: false };

	static getDerivedStateFromError(): PageBoundaryState {
		return { failed: true };
	}

	componentDidCatch(error: Error, _info: ErrorInfo) {
		console.error("Unable to render this page", error);
	}

	render() {
		if (this.state.failed) {
			return (
				<main className="page">
					<section className="box empty" role="alert">
						<h2>This page couldn't be shown</h2>
						<p>
							Something in its data was unexpected. The rest of the dashboard still works:{" "}
							<a href="#/">go to Repositories</a> or reload to try again.
						</p>
					</section>
				</main>
			);
		}
		return this.props.children;
	}
}
