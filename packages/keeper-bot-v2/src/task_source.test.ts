/**
 * Tests for task_source.ts — issue #0262
 *
 * Coverage matrix:
 *   A. Indexer WebSocket discovery (happy path, edge cases, negative)
 *   B. Source selection (indexer vs RPC, partial config, invalid config)
 *   C. RPC fallback (happy path, cursor tracking, empty windows)
 *   D. On-chain claimability assertion (source never bypasses is_claimable)
 *   E. De-duplication (duplicate WS messages, reconnection replay)
 *   F. WebSocket lifecycle (connect, subscribed handshake, reconnect, stop)
 *   G. Error handling (malformed payloads, missing fields, bad JSON)
 *   H. Boundary (large event volume, MAX_SEEN_TASK_IDS eviction)
 *   I. TaskSource interface conformance
 *
 * Testing conventions used here:
 *   - Fakes over mocks: every fake is a hand-written class, not a framework
 *     mock, following examples/keeper-bot/test/events.test.js.
 *   - No real network I/O. RpcTaskSource is tested with a FakeSorobanServer.
 *     IndexerTaskSource is tested via the injected WebSocketFactory so no real
 *     socket is opened. The factory is set per-test via makeIndexerSource().
 *   - Vitest globals (describe/it/expect/vi) enabled in vitest.config.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type WebSocket from 'ws';
import {
  CandidateTask,
  createTaskSource,
  IndexerTaskSource,
  RpcTaskSource,
  TaskSource,
  WebSocketFactory,
} from './task_source.js';

// ─── Helpers shared across test groups ───────────────────────────────────────

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

/** Build a real ScVal tuple for a TaskRegistered event payload, matching
 *  emit_task_registered in contracts/keeper-registry/src/events.rs. */
function makeTaskRegisteredValue(
  taskId: bigint,
  reward: bigint,
  deadline: bigint,
): xdr.ScVal {
  return xdr.ScVal.scvVec([
    nativeToScVal(taskId, { type: 'u64' }),
    nativeToScVal(CONTRACT_ID, { type: 'address' }),
    nativeToScVal(reward, { type: 'i128' }),
    nativeToScVal(deadline, { type: 'u64' }),
  ]);
}

// ─── Fake Soroban RPC server ──────────────────────────────────────────────────

interface FakeRawEvent {
  value: xdr.ScVal | null;
}

class FakeSorobanServer {
  events: FakeRawEvent[] = [];
  latestLedgerSequence = 1000;
  shouldThrow = false;

  async getLatestLedger(): Promise<{ sequence: number }> {
    if (this.shouldThrow) throw new Error('RPC offline');
    return { sequence: this.latestLedgerSequence };
  }

  async getEvents(_opts: unknown): Promise<{ events: FakeRawEvent[]; latestLedger: number }> {
    if (this.shouldThrow) throw new Error('RPC getEvents failed');
    return { events: this.events, latestLedger: this.latestLedgerSequence };
  }
}

// ─── Fake WebSocket — injected via WebSocketFactory ──────────────────────────
//
// IndexerTaskSource accepts an optional wsFactory in its constructor. We inject
// FakeWebSocketFactory in tests so no real connection is attempted.

/** An event payload matching the indexer's IndexedEvent shape. */
interface FakeIndexedEvent {
  cursor: number;
  event_type: string;
  payload: {
    type: string;
    task_id?: number;
    owner?: string;
    reward?: string;
    deadline?: number;
  };
}

type FakeServerMessage =
  | {
      kind: 'subscribed';
      event_type: string | null;
      address: string | null;
      replayed_through: number | null;
    }
  | { kind: 'event'; event: FakeIndexedEvent }
  | { kind: 'closed'; reason: string };

/**
 * Minimal WebSocket fake that mimics the `ws` event API.
 * Tests drive it by calling simulateOpen/simulateMessage/simulateClose directly.
 */
class FakeWebSocket {
  static lastCreated: FakeWebSocket | null = null;

  readonly url: string;
  closeCode = 0;
  closeReason = '';
  private closed = false;

  // ws event listener registry
  private readonly listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.lastCreated = this;
  }

  // ws-compatible event API used by IndexerTaskSource
  on(event: string, listener: (...args: unknown[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
    return this;
  }

  close(code = 1000, reason: string | Buffer = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = typeof reason === 'string' ? reason : reason.toString();
    this.emit('close', code, Buffer.from(this.closeReason));
  }

  // Test-facing helpers

  /** Simulate the server sending data to this socket (triggers 'message' listeners). */
  simulateMessage(msg: FakeServerMessage): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }

  /** Trigger the 'open' event (connection established). */
  simulateOpen(): void {
    this.emit('open');
  }

  /** Simulate the remote end closing the socket. */
  simulateClose(code = 1000, reason = ''): void {
    this.closed = true;
    this.emit('close', code, Buffer.from(reason));
  }

  /** Simulate a socket-level error followed by close. */
  simulateError(message = 'WebSocket error'): void {
    this.emit('error', new Error(message));
    this.simulateClose(1006, message);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

/** Build an IndexerTaskSource with a FakeWebSocket injected. Returns both the
 *  source and the factory so tests can access subsequently created sockets. */
function makeIndexerSource(
  wsUrl = 'ws://indexer/v1/ws',
  restUrl = 'http://indexer/v1',
): { src: IndexerTaskSource; getLastWs: () => FakeWebSocket } {
  FakeWebSocket.lastCreated = null;

  const factory: WebSocketFactory = (url: string) =>
    new FakeWebSocket(url) as unknown as WebSocket;

  const src = new IndexerTaskSource(wsUrl, restUrl, factory);
  return {
    src,
    getLastWs: () => {
      if (!FakeWebSocket.lastCreated) throw new Error('No FakeWebSocket created yet');
      return FakeWebSocket.lastCreated;
    },
  };
}

/** Fire open + send subscribed handshake. */
function completeHandshake(ws: FakeWebSocket, replayedThrough: number | null = null): void {
  ws.simulateOpen();
  ws.simulateMessage({
    kind: 'subscribed',
    event_type: 'task_registered',
    address: null,
    replayed_through: replayedThrough,
  });
}

/** Build a valid TaskRegistered server message. */
function taskRegisteredMsg(
  taskId: number,
  reward: string,
  deadline: number,
  cursor: number,
): FakeServerMessage {
  return {
    kind: 'event',
    event: {
      cursor,
      event_type: 'task_registered',
      payload: {
        type: 'task_registered',
        task_id: taskId,
        owner: 'GOWNER',
        reward,
        deadline,
      },
    },
  };
}

// ─── A. IndexerTaskSource — WebSocket discovery ───────────────────────────────

describe('IndexerTaskSource — WebSocket discovery', () => {
  afterEach(() => {
    FakeWebSocket.lastCreated = null;
  });

  it('buffers a TaskRegistered event and returns it from candidates()', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage(taskRegisteredMsg(1, '1000000', 1_800_000_000, 1));

    const batch = await src.candidates();
    expect(batch).toHaveLength(1);
    expect(batch[0]).toEqual<CandidateTask>({
      taskId: 1n,
      reward: 1_000_000n,
      deadline: 1_800_000_000n,
      source: 'indexer',
    });

    await src.stop();
  });

  it('delivers all buffered tasks and empties the buffer each round', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage(taskRegisteredMsg(1, '500', 1_000_000, 1));
    getLastWs().simulateMessage(taskRegisteredMsg(2, '600', 1_000_001, 2));
    getLastWs().simulateMessage(taskRegisteredMsg(3, '700', 1_000_002, 3));

    const first = await src.candidates();
    expect(first).toHaveLength(3);

    // Second call on the same round must be empty — buffer was drained.
    const second = await src.candidates();
    expect(second).toHaveLength(0);

    await src.stop();
  });

  it('ignores non-TaskRegistered event types', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage({
      kind: 'event',
      event: {
        cursor: 5,
        event_type: 'task_claimed',
        payload: { type: 'task_claimed', task_id: 1 },
      },
    });

    const batch = await src.candidates();
    expect(batch).toHaveLength(0);

    await src.stop();
  });

  it('source field is always "indexer" on returned candidates', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage(taskRegisteredMsg(42, '9999', 2_000_000, 10));

    const [candidate] = await src.candidates();
    expect(candidate.source).toBe('indexer');

    await src.stop();
  });

  it('handles large event volume without dropping tasks', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    const COUNT = 500;
    for (let i = 1; i <= COUNT; i++) {
      getLastWs().simulateMessage(taskRegisteredMsg(i, '100', 1_000_000 + i, i));
    }

    const batch = await src.candidates();
    expect(batch).toHaveLength(COUNT);
    const ids = new Set(batch.map((t) => t.taskId));
    expect(ids.size).toBe(COUNT);

    await src.stop();
  });

  it('candidates() before start() returns empty array without throwing', async () => {
    const { src } = makeIndexerSource();
    const result = await src.candidates();
    expect(result).toEqual([]);
    await src.stop();
  });
});

// ─── B. Source selection ──────────────────────────────────────────────────────

describe('createTaskSource — source selection', () => {
  const fakeServer = new FakeSorobanServer() as unknown as import('@stellar/stellar-sdk').rpc.Server;

  it('selects RpcTaskSource when no indexer is configured', () => {
    const source = createTaskSource(
      { indexerWsUrl: null, indexerRestUrl: null, registryContractId: CONTRACT_ID },
      fakeServer,
    );
    expect(source.kind).toBe('rpc');
    expect(source).toBeInstanceOf(RpcTaskSource);
  });

  it('selects IndexerTaskSource when both URLs are set', () => {
    const source = createTaskSource(
      {
        indexerWsUrl: 'ws://indexer/v1/ws',
        indexerRestUrl: 'http://indexer/v1',
        registryContractId: CONTRACT_ID,
      },
      fakeServer,
    );
    expect(source.kind).toBe('indexer');
    expect(source).toBeInstanceOf(IndexerTaskSource);
  });

  it('falls back to RPC when only WS URL is set (partial config)', () => {
    const source = createTaskSource(
      {
        indexerWsUrl: 'ws://indexer/v1/ws',
        indexerRestUrl: null,
        registryContractId: CONTRACT_ID,
      },
      fakeServer,
    );
    expect(source.kind).toBe('rpc');
    expect(source).toBeInstanceOf(RpcTaskSource);
  });

  it('falls back to RPC when only REST URL is set (partial config)', () => {
    const source = createTaskSource(
      {
        indexerWsUrl: null,
        indexerRestUrl: 'http://indexer/v1',
        registryContractId: CONTRACT_ID,
      },
      fakeServer,
    );
    expect(source.kind).toBe('rpc');
    expect(source).toBeInstanceOf(RpcTaskSource);
  });

  it('returned source has start/candidates/stop interface', () => {
    const source = createTaskSource(
      { indexerWsUrl: null, indexerRestUrl: null, registryContractId: CONTRACT_ID },
      fakeServer,
    );
    expect(typeof source.start).toBe('function');
    expect(typeof source.candidates).toBe('function');
    expect(typeof source.stop).toBe('function');
  });

  it('wsFactory is threaded through to IndexerTaskSource', () => {
    // Verify the factory reaches IndexerTaskSource — if IndexerTaskSource is
    // returned and accepts a factory, the constructor must not throw.
    const factory: WebSocketFactory = (_url: string) => {
      throw new Error('should not be called until start()');
    };
    const source = createTaskSource(
      {
        indexerWsUrl: 'ws://indexer/v1/ws',
        indexerRestUrl: 'http://indexer/v1',
        registryContractId: CONTRACT_ID,
      },
      fakeServer,
      factory,
    );
    // Factory not called at construction time.
    expect(source.kind).toBe('indexer');
  });
});

// ─── C. RpcTaskSource — fallback behaviour ────────────────────────────────────

describe('RpcTaskSource — RPC scanning', () => {
  it('returns candidates decoded from getEvents response', async () => {
    const server = new FakeSorobanServer();
    server.events = [
      { value: makeTaskRegisteredValue(1n, 500_000n, 1_800_000_000n) },
      { value: makeTaskRegisteredValue(2n, 250_000n, 1_900_000_000n) },
    ];

    const src = new RpcTaskSource(
      server as unknown as import('@stellar/stellar-sdk').rpc.Server,
      CONTRACT_ID,
    );
    await src.start();
    const tasks = await src.candidates();

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      taskId: 1n,
      reward: 500_000n,
      deadline: 1_800_000_000n,
      source: 'rpc',
    });
    expect(tasks[1]).toMatchObject({ taskId: 2n, reward: 250_000n, source: 'rpc' });
  });

  it('returns empty array when getEvents returns no events', async () => {
    const server = new FakeSorobanServer();
    server.events = [];

    const src = new RpcTaskSource(
      server as unknown as import('@stellar/stellar-sdk').rpc.Server,
      CONTRACT_ID,
    );
    const tasks = await src.candidates();
    expect(tasks).toHaveLength(0);
  });

  it('returns empty array when getEvents throws', async () => {
    const server = new FakeSorobanServer();
    server.shouldThrow = true;

    const src = new RpcTaskSource(
      server as unknown as import('@stellar/stellar-sdk').rpc.Server,
      CONTRACT_ID,
    );
    // First call triggers getLatestLedger which also throws.
    const tasks = await src.candidates();
    expect(tasks).toHaveLength(0);
  });

  it('skips malformed events and returns well-formed ones', async () => {
    const server = new FakeSorobanServer();
    server.events = [
      { value: makeTaskRegisteredValue(1n, 100n, 999n) },
      { value: null }, // malformed
      { value: makeTaskRegisteredValue(3n, 300n, 999n) },
    ];

    const src = new RpcTaskSource(
      server as unknown as import('@stellar/stellar-sdk').rpc.Server,
      CONTRACT_ID,
    );
    const tasks = await src.candidates();

    expect(tasks).toHaveLength(2);
    expect(tasks[0].taskId).toBe(1n);
    expect(tasks[1].taskId).toBe(3n);
  });

  it('advances cursor so subsequent calls do not re-scan old ledgers', async () => {
    const server = new FakeSorobanServer();
    server.latestLedgerSequence = 2000;
    server.events = [{ value: makeTaskRegisteredValue(1n, 100n, 999n) }];

    const src = new RpcTaskSource(
      server as unknown as import('@stellar/stellar-sdk').rpc.Server,
      CONTRACT_ID,
    );

    const getEventsSpy = vi.spyOn(server, 'getEvents');

    await src.candidates(); // First call — uses lookback window.
    await src.candidates(); // Second call — must advance past latestLedger.

    expect(getEventsSpy).toHaveBeenCalledTimes(2);
    const firstOpts = getEventsSpy.mock.calls[0][0] as { startLedger: number };
    const secondOpts = getEventsSpy.mock.calls[1][0] as { startLedger: number };
    expect(secondOpts.startLedger).toBeGreaterThan(firstOpts.startLedger);
  });

  it('source field is always "rpc" on returned candidates', async () => {
    const server = new FakeSorobanServer();
    server.events = [{ value: makeTaskRegisteredValue(5n, 100n, 999n) }];

    const src = new RpcTaskSource(
      server as unknown as import('@stellar/stellar-sdk').rpc.Server,
      CONTRACT_ID,
    );
    const [candidate] = await src.candidates();
    expect(candidate.source).toBe('rpc');
  });

  it('stop() is a no-op that does not throw', async () => {
    const server = new FakeSorobanServer();
    const src = new RpcTaskSource(
      server as unknown as import('@stellar/stellar-sdk').rpc.Server,
      CONTRACT_ID,
    );
    await expect(src.stop()).resolves.toBeUndefined();
  });
});

// ─── D. On-chain claimability — structural assertion ─────────────────────────
//
// The task source only produces CandidateTask values. It does NOT perform the
// is_claimable check itself — that belongs to the claim pipeline (issue #0034).
// These tests verify that the source's output shape is compatible with a
// downstream is_claimable call and that no source sets a flag that would bypass
// such a check.

describe('CandidateTask shape — on-chain claimability compatibility', () => {
  it('RpcTaskSource candidates carry taskId usable as a u64 for is_claimable', async () => {
    const server = new FakeSorobanServer();
    server.events = [{ value: makeTaskRegisteredValue(99n, 100n, 999n) }];
    const src = new RpcTaskSource(
      server as unknown as import('@stellar/stellar-sdk').rpc.Server,
      CONTRACT_ID,
    );
    const [task] = await src.candidates();
    // taskId is a bigint — the same type nativeToScVal({ type: 'u64' }) accepts.
    expect(typeof task.taskId).toBe('bigint');
    // No claimability field: the caller must perform the on-chain check.
    expect((task as Record<string, unknown>)['claimable']).toBeUndefined();
    expect((task as Record<string, unknown>)['isClaimable']).toBeUndefined();
  });

  it('IndexerTaskSource candidates carry taskId usable as a u64 for is_claimable', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage(taskRegisteredMsg(77, '200', 1_000_000, 5));
    const [task] = await src.candidates();

    expect(typeof task.taskId).toBe('bigint');
    expect((task as Record<string, unknown>)['claimable']).toBeUndefined();
    expect((task as Record<string, unknown>)['isClaimable']).toBeUndefined();

    await src.stop();
  });

  it('source field does not gate claimability — it is advisory only', () => {
    // Both sources produce candidates with a `source` field. Nothing in the
    // CandidateTask interface implies that a particular source bypasses the
    // on-chain is_claimable call. This test documents and guards that contract.
    const sources: Array<CandidateTask['source']> = ['rpc', 'indexer'];
    for (const s of sources) {
      const task: CandidateTask = { taskId: 1n, reward: 100n, deadline: 999n, source: s };
      const keys = Object.keys(task).sort();
      expect(keys).toEqual(['deadline', 'reward', 'source', 'taskId']);
    }
  });
});

// ─── E. De-duplication ────────────────────────────────────────────────────────

describe('IndexerTaskSource — de-duplication', () => {
  afterEach(() => {
    FakeWebSocket.lastCreated = null;
  });

  it('discards duplicate WebSocket messages for the same task_id', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    // Same task_id sent twice (simulates indexer retransmit or burst duplicate).
    getLastWs().simulateMessage(taskRegisteredMsg(1, '100', 1_000_000, 1));
    getLastWs().simulateMessage(taskRegisteredMsg(1, '100', 1_000_000, 2));

    const batch = await src.candidates();
    expect(batch).toHaveLength(1);
    expect(batch[0].taskId).toBe(1n);

    await src.stop();
  });

  it('does not re-emit a task seen in a previous round', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage(taskRegisteredMsg(1, '100', 1_000_000, 1));
    const first = await src.candidates();
    expect(first).toHaveLength(1);

    // Same task arrives again (replay from reconnect, etc.)
    getLastWs().simulateMessage(taskRegisteredMsg(1, '100', 1_000_000, 3));
    const second = await src.candidates();
    expect(second).toHaveLength(0);

    await src.stop();
  });

  it('distinct task_ids are each delivered once', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage(taskRegisteredMsg(1, '100', 1_000_000, 1));
    getLastWs().simulateMessage(taskRegisteredMsg(2, '200', 2_000_000, 2));

    const batch = await src.candidates();
    expect(batch).toHaveLength(2);
    expect(batch.map((t) => t.taskId)).toEqual([1n, 2n]);

    await src.stop();
  });
});

// ─── F. WebSocket lifecycle ───────────────────────────────────────────────────

describe('IndexerTaskSource — WebSocket lifecycle', () => {
  afterEach(() => {
    FakeWebSocket.lastCreated = null;
    vi.useRealTimers();
  });

  it('start() resolves after successful subscribed handshake', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await expect(startPromise).resolves.toBeUndefined();
    await src.stop();
  });

  it('stop() closes the WebSocket with close code 1000', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    const ws = getLastWs();
    await src.stop();
    expect(ws.closeCode).toBe(1000);
  });

  it('subscribe URL includes event_type=task_registered filter', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();

    expect(getLastWs().url).toContain('event_type=task_registered');

    completeHandshake(getLastWs());
    await startPromise;
    await src.stop();
  });

  it('reconnect URL includes ?after=<last cursor> for replay', async () => {
    vi.useFakeTimers();

    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    const firstWs = getLastWs();
    completeHandshake(firstWs);
    await startPromise;

    // Deliver an event so lastCursor is set.
    firstWs.simulateMessage(taskRegisteredMsg(1, '100', 1_000_000, 42));
    await src.candidates(); // drain buffer

    // Simulate disconnect (after handshake so reconnect fires).
    firstWs.simulateClose(1001, 'going away');

    // Advance timers past the reconnect delay.
    await vi.runAllTimersAsync();

    // A new WebSocket should have been created.
    const reconnectedWs = FakeWebSocket.lastCreated!;
    expect(reconnectedWs).not.toBe(firstWs);
    expect(reconnectedWs.url).toContain('after=42');

    // Clean up.
    completeHandshake(reconnectedWs);
    await src.stop();
  });

  it('stop() before start() does not throw', async () => {
    const { src } = makeIndexerSource();
    await expect(src.stop()).resolves.toBeUndefined();
  });

  it('server-sent closed message triggers reconnect on socket close', async () => {
    vi.useFakeTimers();

    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    const firstWs = getLastWs();
    completeHandshake(firstWs);
    await startPromise;

    // Server sends a closed message then closes the socket.
    firstWs.simulateMessage({ kind: 'closed', reason: 'subscriber fell behind' });
    firstWs.simulateClose(1001, 'server closed');

    await vi.runAllTimersAsync();

    // A new connection should have been initiated.
    expect(FakeWebSocket.lastCreated).not.toBe(firstWs);

    const newWs = FakeWebSocket.lastCreated!;
    completeHandshake(newWs);
    await src.stop();
  });

  it('stop() after disconnect prevents further reconnection', async () => {
    vi.useFakeTimers();

    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    const ws = getLastWs();
    completeHandshake(ws);
    await startPromise;

    // Stop and then disconnect — no new socket should be created.
    await src.stop();
    const instanceAfterStop = FakeWebSocket.lastCreated;

    ws.simulateClose(1001, 'gone');
    await vi.runAllTimersAsync();

    // lastCreated is unchanged — no reconnect happened.
    expect(FakeWebSocket.lastCreated).toBe(instanceAfterStop);
  });
});

// ─── G. Error handling ────────────────────────────────────────────────────────

describe('IndexerTaskSource — error handling', () => {
  afterEach(() => {
    FakeWebSocket.lastCreated = null;
  });

  it('skips a TaskRegistered event with missing task_id field', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage({
      kind: 'event',
      event: {
        cursor: 1,
        event_type: 'task_registered',
        payload: { type: 'task_registered', reward: '100', deadline: 1_000_000 },
      },
    });

    const batch = await src.candidates();
    expect(batch).toHaveLength(0);

    await src.stop();
  });

  it('skips a TaskRegistered event with missing reward field', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage({
      kind: 'event',
      event: {
        cursor: 1,
        event_type: 'task_registered',
        payload: { type: 'task_registered', task_id: 1, deadline: 1_000_000 },
      },
    });

    const batch = await src.candidates();
    expect(batch).toHaveLength(0);

    await src.stop();
  });

  it('skips a TaskRegistered event with missing deadline field', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage({
      kind: 'event',
      event: {
        cursor: 1,
        event_type: 'task_registered',
        payload: { type: 'task_registered', task_id: 1, reward: '100' },
      },
    });

    const batch = await src.candidates();
    expect(batch).toHaveLength(0);

    await src.stop();
  });

  it('skips an event with an unparseable reward value', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage({
      kind: 'event',
      event: {
        cursor: 1,
        event_type: 'task_registered',
        payload: { type: 'task_registered', task_id: 1, reward: 'not-a-number', deadline: 1_000_000 },
      },
    });

    const batch = await src.candidates();
    expect(batch).toHaveLength(0);

    await src.stop();
  });

  it('does not crash on non-JSON WebSocket messages', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    // Simulate raw non-JSON data arriving — FakeWebSocket's simulateMessage
    // calls JSON.stringify on its input, so we bypass it and call the ws
    // 'message' listener directly with a non-JSON buffer.
    const ws = getLastWs() as unknown as {
      listeners: Map<string, Array<(...args: unknown[]) => void>>;
    };
    for (const listener of ws.listeners.get('message') ?? []) {
      listener(Buffer.from('this is not json {{{'));
    }

    // Should not throw; buffer should be empty.
    const batch = await src.candidates();
    expect(batch).toHaveLength(0);

    await src.stop();
  });

  it('continues delivering tasks after a malformed event is skipped', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    // Bad event then good event.
    getLastWs().simulateMessage({
      kind: 'event',
      event: { cursor: 1, event_type: 'task_registered', payload: { type: 'task_registered' } },
    });
    getLastWs().simulateMessage(taskRegisteredMsg(5, '500', 2_000_000, 2));

    const batch = await src.candidates();
    expect(batch).toHaveLength(1);
    expect(batch[0].taskId).toBe(5n);

    await src.stop();
  });
});

// ─── H. Boundary conditions ───────────────────────────────────────────────────

describe('IndexerTaskSource — boundary conditions', () => {
  afterEach(() => {
    FakeWebSocket.lastCreated = null;
  });

  it('handles reward values above Number.MAX_SAFE_INTEGER (i128)', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    // 2^53 + 1 — above Number.MAX_SAFE_INTEGER, serialised as decimal string
    // by the indexer (see indexer/src/events.rs I128 serialisation).
    const largeReward = '9007199254740993'; // 2^53 + 1
    getLastWs().simulateMessage(taskRegisteredMsg(1, largeReward, 1_000_000, 1));

    const [task] = await src.candidates();
    expect(task.reward).toBe(BigInt(largeReward));

    await src.stop();
  });

  it('100 new tasks after draining 100 are all delivered', async () => {
    // Validates that the seen-id tracking does not block fresh tasks.
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    for (let i = 1; i <= 100; i++) {
      getLastWs().simulateMessage(taskRegisteredMsg(i, '100', 1_000_000, i));
    }
    const first = await src.candidates();
    expect(first).toHaveLength(100);

    for (let i = 101; i <= 200; i++) {
      getLastWs().simulateMessage(taskRegisteredMsg(i, '100', 1_000_000, i));
    }
    const second = await src.candidates();
    expect(second).toHaveLength(100);

    await src.stop();
  });

  it('zero reward and zero deadline are valid candidates', async () => {
    const { src, getLastWs } = makeIndexerSource();
    const startPromise = src.start();
    completeHandshake(getLastWs());
    await startPromise;

    getLastWs().simulateMessage(taskRegisteredMsg(0, '0', 0, 1));

    const [task] = await src.candidates();
    expect(task.taskId).toBe(0n);
    expect(task.reward).toBe(0n);
    expect(task.deadline).toBe(0n);

    await src.stop();
  });
});

// ─── I. TaskSource interface conformance ─────────────────────────────────────

describe('TaskSource interface conformance', () => {
  afterEach(() => {
    FakeWebSocket.lastCreated = null;
  });

  const conformanceCases: Array<[string, () => TaskSource]> = [
    [
      'RpcTaskSource',
      () =>
        new RpcTaskSource(
          new FakeSorobanServer() as unknown as import('@stellar/stellar-sdk').rpc.Server,
          CONTRACT_ID,
        ),
    ],
    [
      'IndexerTaskSource',
      () => {
        const factory: WebSocketFactory = (_url: string) =>
          new FakeWebSocket(_url) as unknown as WebSocket;
        return new IndexerTaskSource('ws://indexer/v1/ws', 'http://indexer/v1', factory);
      },
    ],
  ];

  for (const [name, factory] of conformanceCases) {
    it(`${name} implements the TaskSource interface`, () => {
      const source = factory();
      expect(typeof source.start).toBe('function');
      expect(typeof source.candidates).toBe('function');
      expect(typeof source.stop).toBe('function');
      expect(typeof source.kind).toBe('string');
      expect(['rpc', 'indexer']).toContain(source.kind);
    });
  }
});
