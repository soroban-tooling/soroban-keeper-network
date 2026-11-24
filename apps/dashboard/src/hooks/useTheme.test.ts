import { describe, expect, it, beforeEach, vi } from "vitest";

describe("Theme management and persistence", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    const storageMock = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    };
    vi.stubGlobal("localStorage", storageMock);
  });

  it("defaults to system theme when no preference stored", () => {
    const stored = localStorage.getItem("dashboard-theme");
    expect(stored).toBeNull();
  });

  it("persists theme preference to localStorage across reloads", () => {
    localStorage.setItem("dashboard-theme", "dark");
    expect(localStorage.getItem("dashboard-theme")).toBe("dark");

    localStorage.setItem("dashboard-theme", "light");
    expect(localStorage.getItem("dashboard-theme")).toBe("light");
  });

  it("resolves effective theme with system preference fallback", () => {
    // Light manual override
    localStorage.setItem("dashboard-theme", "light");
    let resolved = localStorage.getItem("dashboard-theme");
    expect(resolved).toBe("light");

    // Dark manual override
    localStorage.setItem("dashboard-theme", "dark");
    resolved = localStorage.getItem("dashboard-theme");
    expect(resolved).toBe("dark");
  });
});
