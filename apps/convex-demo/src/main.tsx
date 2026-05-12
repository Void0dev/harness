import React from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App";
import "./styles.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found");
}

if (!convexUrl) {
  createRoot(root).render(
    <React.StrictMode>
      <App missingConvexUrl />
    </React.StrictMode>,
  );
} else {
  const convex = new ConvexReactClient(convexUrl);

  createRoot(root).render(
    <React.StrictMode>
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    </React.StrictMode>,
  );
}
