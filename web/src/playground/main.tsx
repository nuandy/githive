// The theme, with Tailwind under it: every style the dashboard has.
import "../theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Playground } from "./Playground";
import { keepThemeCurrent } from "../lib/theme";

// The Hive playground, served in development only (web/playground.html): the real Hive tab, fed by the simulator.

keepThemeCurrent();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Playground />
	</StrictMode>,
);
