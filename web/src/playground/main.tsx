import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Playground } from "./Playground";
import "../styles.css";

// The Hive playground, served in development only (web/playground.html): the real Hive tab, fed by the simulator.

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Playground />
	</StrictMode>,
);
