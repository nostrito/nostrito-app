import { initApp } from "./app";

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app element");
  initApp(root);
});
