import { useCallback, useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("dashboard-theme") as Theme | null;
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    } catch {
      return "system";
    }
  });

  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("dashboard-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // ignore
    }
    return typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => {
      const isDark = theme === "dark" || (theme === "system" && media.matches);
      const effective: "light" | "dark" = isDark ? "dark" : "light";
      setResolvedTheme(effective);
      document.documentElement.setAttribute("data-theme", effective);
    };

    updateTheme();

    const listener = () => {
      if (theme === "system") {
        updateTheme();
      }
    };

    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem("dashboard-theme", next);
    } catch {
      // ignore
    }
    setThemeState(next);
  }, []);

  return { theme, resolvedTheme, setTheme };
}
