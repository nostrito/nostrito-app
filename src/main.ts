import { initApp } from "./app";

document.addEventListener("DOMContentLoaded", async () => {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app element");
  await initApp(root);
});
