import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type RunOptions } from "../src/cli.js";
import { EXIT } from "../src/exitCodes.js";
import { CLAIMED_RAW_TASK, CONTRACT_ID, KEEPER, OWNER, PENDING_RAW_TASK, TEST_SECRET } from "./support/env.js";
import { FakeRpc } from "./support/fakeRpc.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skn-task-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Options for one invocation: a fake RPC, no config file, and an optional signing key. */
function options(server: FakeRpc, extra: Partial<RunOptions> = {}, withKey = false): RunOptions {
  return {
    server,
    env: { SKN_CONFIG: join(dir, "none.json"), ...(withKey ? { SKN_SECRET_KEY: TEST_SECRET } : {}) },
    homeDir: dir,
    platform: "linux",
    ...extra,
  };
}

describe("skn task show", () => {
  it("prints a pending task with the reward in token units and stroops", async () => {
    const server = new FakeRpc({ results: { get_task: PENDING_RAW_TASK } });

    const result = await run(["task", "show", "1", "--contract-id", CONTRACT_ID], options(server));

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("status:        pending");
    expect(result.stdout).toContain("reward:        0.5 tokens (5000000 stroops)");
    expect(result.stdout).toContain("claimer:       none");
    expect(result.stdout).not.toContain("lock expires");
  });

  it("shows the claimer and the lock expiry for a claimed task", async () => {
    const server = new FakeRpc({ results: { get_task: CLAIMED_RAW_TASK } });

    const result = await run(["task", "show", "1", "--contract-id", CONTRACT_ID], options(server));

    expect(result.stdout).toContain(`claimer:       ${KEEPER}`);
    expect(result.stdout).toContain("lock expires:  after ledger 600 (claimed at ledger 500)");
  });

  it("returns the raw fields with --json, with bigints as strings and calldata as base64", async () => {
    const server = new FakeRpc({ results: { get_task: PENDING_RAW_TASK } });

    const result = await run(
      ["task", "show", "1", "--contract-id", CONTRACT_ID, "--json"],
      options(server),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      taskId: "1",
      owner: OWNER,
      reward: "5000000",
      calldata: "AQID",
      status: 0,
    });
  });

  it("exits 5 with a clear message for an unknown ID", async () => {
    const server = new FakeRpc({
      simulationErrors: { get_task: "host invocation failed: Error(Contract, #4)" },
    });

    const result = await run(["task", "show", "99", "--contract-id", CONTRACT_ID, "--json"], options(server));

    expect(result.exitCode).toBe(EXIT.notFound);
    const error = JSON.parse(result.stdout).error;
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toContain("No task exists with that ID");
  });

  it("exits 2 for an ID that is not a positive integer", async () => {
    const server = new FakeRpc();

    const result = await run(["task", "show", "abc", "--contract-id", CONTRACT_ID], options(server));

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("task ID must be a positive integer");
  });
});

describe("skn task list, from the chain", () => {
  const results = {
    task_count: 3,
    get_tasks_range: [PENDING_RAW_TASK, CLAIMED_RAW_TASK, PENDING_RAW_TASK],
  };

  it("filters by status and reports the chain as the source", async () => {
    const server = new FakeRpc({ results });

    const result = await run(
      ["task", "list", "--status", "pending", "--contract-id", CONTRACT_ID, "--json"],
      options(server),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    const body = JSON.parse(result.stdout);
    expect(body.source).toBe("chain");
    expect(body.tasks.map((task: { taskId: string }) => task.taskId)).toEqual(["1", "3"]);
    expect(body.nextCursor).toBeNull();
  });

  it("filters by keeper against the current claimer", async () => {
    const server = new FakeRpc({ results });

    const result = await run(
      ["task", "list", "--keeper", KEEPER, "--contract-id", CONTRACT_ID, "--json"],
      options(server),
    );

    expect(JSON.parse(result.stdout).tasks.map((task: { taskId: string }) => task.taskId)).toEqual(["2"]);
  });

  it("paginates with --limit and returns a cursor that resumes after the last task", async () => {
    const server = new FakeRpc({ results });

    const first = await run(
      ["task", "list", "--limit", "1", "--contract-id", CONTRACT_ID, "--json"],
      options(server),
    );
    const firstBody = JSON.parse(first.stdout);
    expect(firstBody.tasks).toHaveLength(1);
    expect(firstBody.nextCursor).toBe("2");

    const second = await run(
      ["task", "list", "--limit", "5", "--cursor", firstBody.nextCursor, "--contract-id", CONTRACT_ID, "--json"],
      options(server),
    );
    expect(JSON.parse(second.stdout).tasks.map((task: { taskId: string }) => task.taskId)).toEqual(["2", "3"]);
  });

  it("exits 2 for a --limit outside 1 to 100", async () => {
    const result = await run(
      ["task", "list", "--limit", "0", "--contract-id", CONTRACT_ID],
      options(new FakeRpc({ results })),
    );

    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("exits 2 for an unknown status name", async () => {
    const result = await run(
      ["task", "list", "--status", "sleeping", "--contract-id", CONTRACT_ID],
      options(new FakeRpc({ results })),
    );

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("unknown status 'sleeping'");
  });
});

describe("skn task list, from the indexer", () => {
  const indexerTasks = [
    { task_id: 1, owner: OWNER, status: "pending", keeper: null, reward: "5000000", deadline: 4_102_444_800 },
    { task_id: 2, owner: OWNER, status: "executed", keeper: KEEPER, reward: "7000000", deadline: 4_102_444_800 },
  ];

  function fakeFetch(status: number, body: unknown, seen: string[] = []) {
    return async (url: string) => {
      seen.push(url);
      return { ok: status < 400, status, json: async () => body };
    };
  }

  it("lists an owner's tasks from the indexer and says so", async () => {
    const seen: string[] = [];
    const result = await run(
      ["task", "list", "--owner", OWNER, "--indexer-url", "https://idx.example", "--json"],
      options(new FakeRpc(), { fetch: fakeFetch(200, { address: OWNER, tasks: indexerTasks }, seen) }),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(seen[0]).toBe(`https://idx.example/owners/${OWNER}/tasks`);
    const body = JSON.parse(result.stdout);
    expect(body.source).toBe("indexer");
    expect(body.tasks).toHaveLength(2);
  });

  it("applies the status filter to indexer results", async () => {
    const result = await run(
      ["task", "list", "--owner", OWNER, "--status", "executed", "--indexer-url", "https://idx.example", "--json"],
      options(new FakeRpc(), { fetch: fakeFetch(200, { address: OWNER, tasks: indexerTasks }) }),
    );

    expect(JSON.parse(result.stdout).tasks.map((task: { taskId: number }) => task.taskId)).toEqual([2]);
  });

  it("explains that the indexer needs --owner or --keeper", async () => {
    const result = await run(
      ["task", "list", "--indexer-url", "https://idx.example"],
      options(new FakeRpc(), { fetch: fakeFetch(200, { address: OWNER, tasks: [] }) }),
    );

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("needs --owner or --keeper");
  });

  it("exits 3 when the indexer returns an error", async () => {
    const result = await run(
      ["task", "list", "--owner", OWNER, "--indexer-url", "https://idx.example", "--json"],
      options(new FakeRpc(), { fetch: fakeFetch(500, {}) }),
    );

    expect(result.exitCode).toBe(EXIT.rpc);
    expect(JSON.parse(result.stdout).error.message).toContain("HTTP 500");
  });
});

describe("skn task register", () => {
  const baseArgs = [
    "task",
    "register",
    "--contract-id",
    CONTRACT_ID,
    "--target",
    CONTRACT_ID,
    "--function",
    "liquidate",
    "--args",
    '["GABC", 5]',
    "--reward",
    "5000000",
    "--deadline",
    "+2h",
  ];

  it("refuses to submit without --yes when no one can confirm", async () => {
    const server = new FakeRpc({ results: { register_task: 7n } });

    const result = await run(baseArgs, options(server, {}, true));

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("pass --yes to submit without a prompt");
    expect(server.submitted).toHaveLength(0);
  });

  it("does not submit when the person declines the prompt", async () => {
    const server = new FakeRpc({ results: { register_task: 7n } });

    const result = await run(
      baseArgs,
      options(server, { confirm: async () => false }, true),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toBe("not submitted\n");
    expect(server.submitted).toHaveLength(0);
  });

  it("shows the estimate and submits once confirmed", async () => {
    const server = new FakeRpc({ results: { register_task: 7n } });
    const asked: string[] = [];

    const result = await run(
      baseArgs,
      options(server, { confirm: async (question) => (asked.push(question), true) }, true),
    );

    expect(asked[0]).toContain("estimated resource fee");
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.stdout).toContain("registered task 7");
    expect(server.submitted).toHaveLength(1);
  });

  it("submits directly with --yes and prints the new task ID as JSON", async () => {
    const server = new FakeRpc({ results: { register_task: 7n } });

    const result = await run([...baseArgs, "--yes", "--json"], options(server, {}, true));

    expect(result.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ submitted: true, taskId: "7" });
    expect(server.submitted).toHaveLength(1);
  });

  it("exits 2 when no signing key is set", async () => {
    const server = new FakeRpc({ results: { register_task: 7n } });

    const result = await run([...baseArgs, "--yes"], options(server));

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("no signing key");
    expect(server.submitted).toHaveLength(0);
  });

  it("exits 2 for a deadline that is neither ISO nor a relative duration", async () => {
    const server = new FakeRpc({ results: { register_task: 7n } });

    const result = await run(
      baseArgs.map((arg) => (arg === "+2h" ? "next tuesday" : arg)),
      options(server, {}, true),
    );

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("deadline must be an ISO timestamp");
  });

  it("exits 2 when a required value is missing", async () => {
    const result = await run(
      ["task", "register", "--contract-id", CONTRACT_ID, "--reward", "1", "--deadline", "+2h"],
      options(new FakeRpc(), {}, true),
    );

    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--target is required");
  });

  it("reads the task from a --from file, with flags taking precedence", async () => {
    const { writeFile } = await import("node:fs/promises");
    const file = join(dir, "task.json");
    await writeFile(
      file,
      JSON.stringify({ target: CONTRACT_ID, function: "from_file", args: [], reward: "1", deadline: "+1h" }),
    );
    const server = new FakeRpc({ results: { register_task: 9n } });

    const result = await run(
      ["task", "register", "--contract-id", CONTRACT_ID, "--from", file, "--reward", "2000000", "--yes", "--json"],
      options(server, {}, true),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout).taskId).toBe("9");
  });
});
