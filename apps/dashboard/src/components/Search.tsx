import { CornerDownLeft, Search as SearchIcon, ShieldCheck, UserCheck, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export type SearchRouteResult =
  | { type: "task"; taskId: number; path: string }
  | { type: "address"; address: string; ownerPath: string; keeperPath: string }
  | { type: "invalid"; error: string };

/**
 * Validates and parses search input query into target destination routes.
 */
export function parseSearchQuery(query: string): SearchRouteResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      type: "invalid",
      error: "Enter a task ID (e.g. 42) or a Stellar address starting with 'G'.",
    };
  }

  // 1. Task ID (pure digits, optional leading '#')
  const taskMatch = trimmed.match(/^#?(\d+)$/);
  if (taskMatch) {
    const taskId = Number(taskMatch[1]);
    if (Number.isSafeInteger(taskId) && taskId >= 0) {
      return {
        type: "task",
        taskId,
        path: `/tasks/${taskId}`,
      };
    }
  }

  // 2. Stellar public key address (starts with G, 56 chars)
  const addrClean = trimmed.toUpperCase();
  if (/^G[A-Z2-7]{55}$/.test(addrClean) || /^G[A-Z0-9]{55}$/.test(addrClean)) {
    return {
      type: "address",
      address: addrClean,
      ownerPath: `/owners/${addrClean}`,
      keeperPath: `/keepers/${addrClean}`,
    };
  }

  // Helpful contextual error message for invalid input
  if (trimmed.startsWith("G") || trimmed.startsWith("g")) {
    return {
      type: "invalid",
      error: `Incomplete address (${trimmed.length}/56 characters). A valid Stellar public key must start with 'G' and contain exactly 56 characters.`,
    };
  }

  if (/[a-zA-Z]/.test(trimmed) && /\d/.test(trimmed)) {
    return {
      type: "invalid",
      error: "Invalid format. For a task, enter numbers only. For an account, enter a 56-character 'G...' address.",
    };
  }

  return {
    type: "invalid",
    error: "No matching destination. Enter a task ID (e.g. 42) or a 56-character Stellar address (G...).",
  };
}

export function Search() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState<"owner" | "keeper">("owner");

  const parsed = query.trim() ? parseSearchQuery(query) : null;

  // Global keyboard shortcut: '/' or 'Ctrl+K' / 'Cmd+K' to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput =
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA" ||
        (document.activeElement as HTMLElement)?.isContentEditable;

      // Ctrl+K or Cmd+K
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }

      // '/' when not already inside an input field
      if (e.key === "/" && !isInput) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }

      // Escape to blur/close
      if (e.key === "Escape" && document.activeElement === inputRef.current) {
        inputRef.current?.blur();
        setShowSuggestions(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleExecute = useCallback(
    (targetPath: string) => {
      setFeedback(null);
      setShowSuggestions(false);
      setQuery("");
      navigate(targetPath);
    },
    [navigate]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      setFeedback("Please enter a task ID or Stellar address.");
      return;
    }

    const result = parseSearchQuery(query);
    if (result.type === "task") {
      handleExecute(result.path);
    } else if (result.type === "address") {
      handleExecute(activeSuggestion === "keeper" ? result.keeperPath : result.ownerPath);
    } else {
      setFeedback(result.error);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    setFeedback(null);
    setShowSuggestions(Boolean(val.trim()));
  };

  const handleClear = () => {
    setQuery("");
    setFeedback(null);
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  return (
    <div className="global-search-container">
      <form onSubmit={handleSubmit} role="search">
        <div className="search-input-wrapper">
          <SearchIcon className="search-input-icon" size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            value={query}
            onChange={handleChange}
            onFocus={() => setShowSuggestions(Boolean(query.trim()))}
            placeholder="Search task ID (#42) or address (G...)"
            aria-label="Search by task ID or address"
            aria-expanded={showSuggestions}
            autoComplete="off"
            spellCheck={false}
          />

          {query ? (
            <button
              type="button"
              className="search-clear-btn"
              onClick={handleClear}
              aria-label="Clear search query"
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="search-shortcut-badge" title="Press / or Ctrl+K to search">
              /
            </kbd>
          )}
        </div>
      </form>

      {/* Helpful feedback on invalid input */}
      {feedback && (
        <div className="search-feedback error" role="alert">
          {feedback}
        </div>
      )}

      {/* Suggestion dropdown for instant navigation */}
      {showSuggestions && parsed && (
        <div className="search-suggestions" role="listbox">
          {parsed.type === "task" && (
            <div
              className="search-suggestion-item"
              role="option"
              aria-selected={true}
              onClick={() => handleExecute(parsed.path)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <SearchIcon size={14} />
                <span>Go to <strong>Task #{parsed.taskId}</strong></span>
              </div>
              <CornerDownLeft size={13} style={{ opacity: 0.6 }} />
            </div>
          )}

          {parsed.type === "address" && (
            <>
              <div
                className={`search-suggestion-item ${activeSuggestion === "owner" ? "active" : ""}`}
                role="option"
                aria-selected={activeSuggestion === "owner"}
                onMouseEnter={() => setActiveSuggestion("owner")}
                onClick={() => handleExecute(parsed.ownerPath)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <UserCheck size={14} color="#3b82f6" />
                  <span>View <strong>Owner Tasks</strong> for this address</span>
                </div>
                <CornerDownLeft size={13} style={{ opacity: 0.6 }} />
              </div>

              <div
                className={`search-suggestion-item ${activeSuggestion === "keeper" ? "active" : ""}`}
                role="option"
                aria-selected={activeSuggestion === "keeper"}
                onMouseEnter={() => setActiveSuggestion("keeper")}
                onClick={() => handleExecute(parsed.keeperPath)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ShieldCheck size={14} color="#10b981" />
                  <span>View <strong>Keeper Profile</strong> for this address</span>
                </div>
                <CornerDownLeft size={13} style={{ opacity: 0.6 }} />
              </div>
            </>
          )}

          {parsed.type === "invalid" && (
            <div
              className="search-suggestion-item"
              style={{ color: "#ef4444", fontSize: "0.8rem", cursor: "default" }}
            >
              <span>{parsed.error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
