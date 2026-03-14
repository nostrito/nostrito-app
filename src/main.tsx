import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/wizard.css";
import "./styles/dashboard.css";
import "./styles/feed.css";
import "./styles/screens.css";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app element");
createRoot(root).render(<App />);
