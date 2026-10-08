import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
// Fonts are self-hosted (same origin) so the PDF renderer can embed them;
// with cross-origin Google Fonts it fell back to a wider system font and labels overlapped.
import "@fontsource/ibm-plex-sans-arabic/arabic-400.css";
import "@fontsource/ibm-plex-sans-arabic/arabic-500.css";
import "@fontsource/ibm-plex-sans-arabic/arabic-600.css";
import "@fontsource/ibm-plex-sans-arabic/arabic-700.css";
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-700.css";
import "./styles.css";

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
