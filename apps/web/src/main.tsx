// The global layer only, in cascade order: tokens → base → shared primitives →
// the navigation and readers most pages show. Every other stylesheet comes
// with the lazy chunk that uses it: a page imports its own, and pages that
// Node tests render (no CSS loader there) get theirs from app/routing
// (styled-*.ts) or app/workspace.
import "./shared/styles/tokens.css";
import "./shared/styles/base.css";
import "./shared/ui/controls.css";
import "./shared/ui/dialog.css";
import "./shared/ui/shelf-access.css";
import "./widgets/navigation/navigation.css";
import "./widgets/artifact-preview/styles.css";
import "./widgets/artifact-reader/styles.css";
// Dialog bodies and the file drop of every feature's dialog.
import "./features/upload-artifact/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { AppRoutes } from "./app/routing/index.tsx";
import { preloadHome } from "./app/workspace/home.tsx";
import { SkipLink } from "./shared/ui/SkipLink.tsx";
import { rememberVisitSource } from "./shared/lib/visit-source.ts";

// Before routing may change the address: the ref of the page the visit began on.
rememberVisitSource();
// The landing's or the workspace's chunk downloads beside /api/session, not after it.
preloadHome();

createRoot(document.getElementById("root")!).render(
  <>
    <SkipLink />
    <AppRoutes />
  </>,
);
