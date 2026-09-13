import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Recipient } from "./Recipient.tsx";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  location.pathname === "/s" ? <Recipient /> : <App />,
);
