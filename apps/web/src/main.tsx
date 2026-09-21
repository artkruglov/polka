import "./entry-redesign.css";
import React from "react";
import {createRoot} from "react-dom/client";
import {AppRoutes} from "./app/routing/index.tsx";

// Transitional CSS entry: keep cascade order explicit until route CSS migration is complete.
import "./widgets/editorial-catalog/styles.css";
import "./style.css";
import "./shared/ui/dialog.css";
import "./widgets/artifact-preview/styles.css";
import "./community.css";
import "./entry.css";
import "./modern.css";
import "./widgets/artifact-reader/layout.css";
import "./shared/styles/visual-system.css";
import "./widgets/navigation/navigation.css";
import "./shared/ui/controls.css";
import "./widgets/artifact-reader/styles.css";
import "./pages/agents/styles.css";

createRoot(document.getElementById("root")!).render(<AppRoutes/>);
