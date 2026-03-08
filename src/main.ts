import { initApp } from "./app";

console.log("[main] DOMContentLoaded listener registered");

document.addEventListener("DOMContentLoaded", async () => {
  console.log("[main] DOMContentLoaded fired");
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app element");
  console.log("[main] Calling initApp...");
  await initApp(root);
  console.log("[main] initApp complete");
});
