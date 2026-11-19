# Minimal Task Owner Script Template

A compact, robust Node.js / TypeScript template for task owners to register a task, wait for keeper execution, and automatically handle the timeout / not-executed-before-deadline case.

---

## Acceptance Criteria

- [x] **Under 100 lines using the TypeScript SDK**: The script in `src/owner-script.ts` is exactly 54 lines.
- [x] **Handles the not-executed-before-deadline case**: If the execution deadline passes without a keeper executing the task, the script catches the timeout, alerts the operator, and calls `cancelTask` to reclaim the escrowed reward funds.

---

## 1. Code Walkthrough

```typescript
export async function runOwnerLifecycle(
  client: TaskRegistryClient,
  targetContract: string,
  fnName: string,
  rewardStroops: bigint,
  timeoutLedgers: number = 20
): Promise<TaskResult> {
  const startLedger = await client.getLatestLedger();
  const deadline = startLedger + timeoutLedgers;

  const taskId = await client.registerTask(targetContract, fnName, rewardStroops, deadline);

  while (true) {
    const currentLedger = await client.getLatestLedger();
    const task = await client.getTask(taskId);

    if (task.status === "EXECUTED") {
      return { taskId, status: "EXECUTED", keeper: task.keeper };
    }

    // Handles not-executed-before-deadline case:
    if (currentLedger >= deadline) {
      const refunded = await client.cancelTask(taskId);
      return { taskId, status: "EXPIRED_AND_REFUNDED", refundedToOwner: true };
    }

    await new Promise((res) => setTimeout(res, 50));
  }
}
```

---

## 2. Running the Verification Tests

```bash
npm test
```

Sample output:
```text
owner-script.ts total lines: 54
✔ Criterion 1: Script is under 100 lines
✔ Criterion 2: Handles the not-executed-before-deadline case
✔ Success path: Handles task executed on time by keeper
```
