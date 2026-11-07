import "@fontsource-variable/dm-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
