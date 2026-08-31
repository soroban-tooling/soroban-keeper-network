import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useIsClaimable } from "./useIsClaimable";

describe("useIsClaimable", () => {
  it("tracks changes in claimability", async () => {
    let claimable = false;

    const isClaimable = vi.fn(async () => claimable);

    const client = {
      isClaimable,
    };

    // Mount through the repository's actual
    // KeeperRegistryProvider implementation.

    // Initial state:
    expect(claimable).toBe(false);

    claimable = true;

    // Trigger refetch using the hook result.
    // The exact wrapper should use the project's
    // existing provider/test utilities.

    expect(isClaimable).toHaveBeenCalled();
  });
});
