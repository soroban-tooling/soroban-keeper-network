import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useIsClaimable } from "./useIsClaimable.js";
import { KeeperRegistryProvider } from "./provider.js";

function wrapper(client: unknown) {
  return ({ children }: { children: ReactNode }) =>
    createElement(KeeperRegistryProvider, { client: client as never, children });
}

describe("useIsClaimable", () => {
  it("tracks changes in claimability", async () => {
    let claimable = false;
    const isClaimable = vi.fn(async () => claimable);

    const { result } = renderHook(() => useIsClaimable(1n), {
      wrapper: wrapper({ isClaimable }),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(isClaimable).toHaveBeenCalled();
    expect(result.current.isClaimable).toBe(false);

    claimable = true;
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.isClaimable).toBe(true);
  });
});
