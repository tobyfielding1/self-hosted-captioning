import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initFromUrl } from "./backend";
import "./index.css";

initFromUrl();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
