// The theme, with Tailwind under it: every style the dashboard has.
import "./theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { keepThemeCurrent } from "./lib/theme";

keepThemeCurrent();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
