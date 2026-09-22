// Vite dev entry only: components.html is not a production build input.
import React from "react";
import { createRoot } from "react-dom/client";
import { ComponentCatalog } from "./pages/component-catalog/index.tsx";
import "./shared/styles/tokens.css";
import "./shared/styles/base.css";
import "./shared/ui/controls.css";
import "./shared/ui/dialog.css";
import "./widgets/artifact-preview/styles.css";
createRoot(document.getElementById("root")!).render(<ComponentCatalog />);
