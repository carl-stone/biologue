import React from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchProvider } from "./state.tsx";
import { App } from "./App.tsx";
import "dockview/dist/styles/dockview.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WorkbenchProvider>
      <App />
    </WorkbenchProvider>
  </React.StrictMode>,
);
