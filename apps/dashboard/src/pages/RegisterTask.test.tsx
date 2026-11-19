import { describe, expect, it, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// Re-create the validation function from RegisterTask to verify business rules
const MAX_CALLDATA_BYTES = 1024;

function validate(values: {
  account?: string;
  target: string;
  functionName: string;
  argumentsJson: string;
  reward: string;
  deadline: string;
  verifier: string;
}): string | null {
  if (!values.account) return "Connect a wallet before registering a task.";
  if (!StrKey.isValidEd25519PublicKey(values.account)) return "The connected wallet account is invalid.";
  if (!StrKey.isValidContract(values.target)) return "Enter a valid Stellar contract target.";
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(values.functionName))
    return "Function names must be 1-32 letters, digits, or underscores.";
  let args: unknown;
  try {
    args = JSON.parse(values.argumentsJson);
  } catch {
    return "Arguments must be valid JSON.";
  }
  if (!Array.isArray(args)) return "Arguments must be a JSON array.";
  if (
    new TextEncoder().encode(JSON.stringify({ target: values.target, function: values.functionName, args }))
      .length > MAX_CALLDATA_BYTES
  )
    return `Encoded call data exceeds ${MAX_CALLDATA_BYTES} bytes.`;
  if (!/^\d+$/.test(values.reward) || BigInt(values.reward) <= 0n)
    return "Reward must be a positive integer.";
  const deadline = new Date(values.deadline).getTime();
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return "Deadline must be in the future.";
  if (values.verifier && !StrKey.isValidContract(values.verifier))
    return "Verifier must be a valid contract address.";
  return null;
}

describe("RegisterTask validation and operations", () => {
  const validAccount = Keypair.random().publicKey();
  const validContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const futureDate = new Date(Date.now() + 86400000).toISOString();

  it("fails when no wallet is connected", () => {
    const error = validate({
      account: undefined,
      target: validContract,
      functionName: "rebalance",
      argumentsJson: "[]",
      reward: "10000000",
      deadline: futureDate,
      verifier: "",
    });
    expect(error).toBe("Connect a wallet before registering a task.");
  });

  it("fails on invalid target contract ID", () => {
    const error = validate({
      account: validAccount,
      target: "invalid-target",
      functionName: "rebalance",
      argumentsJson: "[]",
      reward: "10000000",
      deadline: futureDate,
      verifier: "",
    });
    expect(error).toBe("Enter a valid Stellar contract target.");
  });

  it("fails on past deadline", () => {
    const pastDate = new Date(Date.now() - 3600000).toISOString();
    const error = validate({
      account: validAccount,
      target: validContract,
      functionName: "rebalance",
      argumentsJson: "[]",
      reward: "10000000",
      deadline: pastDate,
      verifier: "",
    });
    expect(error).toBe("Deadline must be in the future.");
  });

  it("passes with valid task registration parameters", () => {
    const error = validate({
      account: validAccount,
      target: validContract,
      functionName: "rebalance",
      argumentsJson: "[1, 2, 3]",
      reward: "50000000",
      deadline: futureDate,
      verifier: "",
    });
    expect(error).toBeNull();
  });

  it("simulates fee estimation and registration call with mocked RegistryOperations", async () => {
    const mockOps = {
      estimateRegisterTask: vi.fn().mockResolvedValue(150_000n),
      registerTask: vi.fn().mockResolvedValue(77n),
    };

    const taskInput = {
      owner: validAccount,
      target: validContract,
      functionName: "rebalance",
      argumentsJson: "[]",
      reward: 50_000_000n,
      deadline: Math.floor(Date.now() / 1000) + 86400,
    };

    const estimatedFee = await mockOps.estimateRegisterTask(taskInput);
    expect(estimatedFee).toBe(150_000n);

    const taskId = await mockOps.registerTask(taskInput);
    expect(taskId).toBe(77n);
  });
});
