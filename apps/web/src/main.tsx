import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Recipient } from "./Recipient.tsx";
import { PublicGallery } from "./PublicGallery.tsx";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  location.pathname === "/s" ? <Recipient /> : location.pathname.startsWith("/discover") ? <PublicGallery /> : <App />,
);
