import { Component, type ErrorInfo, type ReactNode } from "react";
import { EmptyPage } from "./Page";

interface PageBoundaryState {
	failed: boolean;
}

/**
 * Keep an unexpected render failure in one page from taking down the whole dashboard. App keys it by place, so each
 * place fades in as you go to it; laid out as a column, like the shell it sits in.
 */
export class PageBoundary extends Component<{ children: ReactNode }, PageBoundaryState> {
	state: PageBoundaryState = { failed: false };

	static getDerivedStateFromError(): PageBoundaryState {
		return { failed: true };
	}

	componentDidCatch(error: Error, _info: ErrorInfo) {
		console.error("Unable to render this page", error);
	}

	render() {
		const { failed } = this.state;
		return (
			<div key={failed ? "failed" : "page"} className="flex animate-fade flex-col">
				{failed ? (
					<EmptyPage role="alert" title="This page couldn't be shown">
						<p>
							Something in its data was unexpected. The rest of the dashboard still works:{" "}
							<a href="#/">go to Repositories</a> or reload to try again.
						</p>
					</EmptyPage>
				) : (
					this.props.children
				)}
			</div>
		);
	}
}
