import { createRoot } from "react-dom/client";
import { App } from "./app";
import { TooltipProvider } from "./components/ui/tooltip";
import { start } from "./lib/store";

start();

const root = document.getElementById("root")!;
createRoot(root).render(
  <TooltipProvider delayDuration={300}>
    <App />
  </TooltipProvider>,
);
