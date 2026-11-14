import { useEffect, useState } from "react";
import { readStorage, writeStorage } from "./hooks.js";

export type ThemeChoice = "light" | "system" | "dark";

const query = () => window.matchMedia("(prefers-color-scheme: dark)");

function apply(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && query().matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

// The chosen theme (remembered per browser), applied to <html data-theme>
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(
    () => (readStorage("theme") as ThemeChoice | null) ?? "system",
  );
  useEffect(() => {
    apply(choice);
    writeStorage("theme", choice);
    if (choice !== "system") return;
    const media = query();
    const update = () => apply("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [choice]);
  return [choice, setChoice] as const;
}
