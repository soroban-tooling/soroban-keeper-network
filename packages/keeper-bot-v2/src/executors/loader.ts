import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ExecutorRegistry, type TaskExecutor } from "./interface.js";

interface ExecutorModule {
  readonly default?: unknown;
  readonly executor?: unknown;
}

export function parseExecutorModuleList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  const modules = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (new Set(modules).size !== modules.length) {
    throw new Error("KEEPER_EXECUTOR_MODULES contains duplicate entries");
  }
  return modules;
}

export async function loadExecutorModules(
  moduleSpecifiers: readonly string[],
  baseDirectory = process.cwd(),
): Promise<ExecutorRegistry> {
  const registry = new ExecutorRegistry();
  for (const specifier of moduleSpecifiers) {
    const loaded = (await import(resolveSpecifier(specifier, baseDirectory))) as ExecutorModule;
    const candidate = loaded.default ?? loaded.executor;
    if (candidate === undefined) {
      throw new TypeError(
        `Executor module ${specifier} must export default or named executor`,
      );
    }
    registry.register(candidate as TaskExecutor);
  }
  return registry;
}

function resolveSpecifier(specifier: string, baseDirectory: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return specifier;
  }
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    return pathToFileURL(resolve(baseDirectory, specifier)).href;
  }
  return specifier;
}
