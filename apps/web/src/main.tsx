// Global layers in cascade order: tokens → base → shared primitives → widgets that
// Node tests render without CSS. Pages and features import their own stylesheets.
import "./shared/styles/tokens.css";
import "./shared/styles/base.css";
import "./shared/ui/controls.css";
import "./shared/ui/dialog.css";
import "./shared/ui/onboard.css";
import "./shared/ui/shelf-access.css";
import "./widgets/navigation/navigation.css";
import "./widgets/artifact-preview/styles.css";
import "./entities/link/styles.css";
import "./widgets/artifact-reader/styles.css";
import "./widgets/editorial-catalog/styles.css";
import "./widgets/trash/styles.css";
import "./pages/agents/styles.css";
// Imported here, not by the feature: pages that import it are rendered in Node tests.
import "./features/provider-sign-in/styles.css";
import "./features/first-run/styles.css";
import "./features/agent-hero/styles.css";
import "./features/upload-artifact/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { AppRoutes } from "./app/routing/index.tsx";
import { rememberVisitSource } from "./shared/lib/visit-source.ts";

// Before routing may change the address: the ref of the page the visit began on.
rememberVisitSource();

createRoot(document.getElementById("root")!).render(<AppRoutes />);
