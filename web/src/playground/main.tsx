// First: it declares the cascade layers every other stylesheet goes in.
import "../theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Playground } from "./Playground";
import "../styles.css";
import { keepThemeCurrent } from "../lib/theme";

// The Hive playground, served in development only (web/playground.html): the real Hive tab, fed by the simulator.

keepThemeCurrent();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Playground />
	</StrictMode>,
);
