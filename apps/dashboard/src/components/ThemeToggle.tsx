import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <div className={`theme-toggle ${className}`} role="radiogroup" aria-label="Theme selection">
      <button
        type="button"
        role="radio"
        aria-checked={theme === "system"}
        className={theme === "system" ? "active" : ""}
        onClick={() => setTheme("system")}
        title="Follow system preference"
      >
        <Monitor aria-hidden="true" style={{ width: 14, height: 14 }} />
        <span>Auto</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={theme === "light"}
        className={theme === "light" ? "active" : ""}
        onClick={() => setTheme("light")}
        title="Light theme"
      >
        <Sun aria-hidden="true" style={{ width: 14, height: 14 }} />
        <span>Light</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={theme === "dark"}
        className={theme === "dark" ? "active" : ""}
        onClick={() => setTheme("dark")}
        title="Dark theme"
      >
        <Moon aria-hidden="true" style={{ width: 14, height: 14 }} />
        <span>Dark</span>
      </button>
    </div>
  );
}
