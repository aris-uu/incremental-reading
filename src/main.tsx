import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ImportView } from "./views/ImportView";
import "./styles.css";
import { initAppearance } from "./appearance";
import { initLinks } from "./links";

initAppearance();
initLinks();

// The same bundle serves both windows; the import window loads with #import.
const isImport = window.location.hash === "#import";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isImport ? <ImportView /> : <App />}</StrictMode>,
);
