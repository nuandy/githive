// First: it declares the cascade layers every other stylesheet goes in.
import "./theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { keepThemeCurrent } from "./lib/theme";

keepThemeCurrent();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
