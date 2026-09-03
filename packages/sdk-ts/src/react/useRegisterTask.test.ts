import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useRegisterTask } from "./useRegisterTask.js";
import { KeeperRegistryProvider } from "./provider.js";

describe("useRegisterTask", () => {
  it("transitions idle -> pending -> success", async () => {
    const registerTask = vi.fn().mockResolvedValue(42);

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(KeeperRegistryProvider, { client: { registerTask } as never, children });

    const { result } = renderHook(
      () => useRegisterTask(),
      { wrapper },
    );

    expect(result.current.status).toBe("idle");

    let promise: Promise<unknown>;

    act(() => {
      promise = result.current.registerTask({
        owner: "G...",
        taskType: "default",
        calldata: [],
        reward: 1,
        deadline: 100,
        ttlLedgers: 100,
        lockLedgers: 10,
      } as never);
    });

    expect(result.current.status).toBe("pending");

    await act(async () => {
      await promise;
    });

    expect(result.current.status).toBe("success");
    expect(result.current.error).toBeNull();
    expect(registerTask).toHaveBeenCalledTimes(1);
  });

  it("transitions idle -> pending -> error", async () => {
    const failure = new Error("registration failed");

    const registerTask = vi
      .fn()
      .mockRejectedValue(failure);

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(KeeperRegistryProvider, { client: { registerTask } as never, children });

    const { result } = renderHook(
      () => useRegisterTask(),
      { wrapper },
    );

    await act(async () => {
      await expect(
        result.current.registerTask({} as never),
      ).rejects.toThrow("registration failed");
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toEqual(failure);
  });

  it("resets the mutation state to idle", async () => {
    const registerTask = vi
      .fn()
      .mockRejectedValue(new Error("failed"));

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(KeeperRegistryProvider, { client: { registerTask } as never, children });

    const { result } = renderHook(
      () => useRegisterTask(),
      { wrapper },
    );

    await act(async () => {
      await expect(
        result.current.registerTask({} as never),
      ).rejects.toThrow();
    });

    expect(result.current.status).toBe("error");

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });
});
