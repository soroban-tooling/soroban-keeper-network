/**
 * Task Source Abstraction — issue #0262
 *
 * Defines the common interface that both RPC-scanning and indexer-backed task
 * discovery implement. Every component downstream of this boundary (evaluation,
 * ranking, claim pipeline) receives a CandidateTask and is unaware of which
 * source produced it.
 *
 * Source selection:
 *   - When BotConfig.indexerWsUrl AND BotConfig.indexerRestUrl are both set →
 *     IndexerTaskSource (WebSocket feed for new TaskRegistered events)
 *   - Otherwise → RpcTaskSource (direct getEvents scanning, v1 behaviour)
 *
 * Critical invariant (issue #0034):
 *   Regardless of which source is active, is_claimable MUST be called on-chain
 *   before every claim_task submission. Indexer data is advisory: it informs
 *   candidate discovery only. The chain is always the authority on claimability.
 */

import { nativeToScVal, rpc as SorobanRpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import WebSocket from 'ws';
import type { BotConfig } from './config.js';

// ─── Shared task model ───────────────────────────────────────────────────────

/**
 * A task candidate that has been discovered but not yet evaluated.
 *
 * Both sources produce exactly this shape so the evaluation pipeline needs no
 * knowledge of where the task came from. The `source` field is carried through
 * for observability / logging only — it must never be used to gate claimability
 * (the on-chain check owns that decision).
 */
export interface CandidateTask {
  taskId: bigint;
  /** Reward in stroops, as reported at registration time. May differ from
   *  current on-chain reward if increase_reward was called since — treat as
   *  a lower bound, not an authoritative figure. */
  reward: bigint;
  /** Deadline as Unix seconds, as reported at registration time. May have been
   *  extended by extend_deadline since — always re-read on-chain before using
   *  for profitability decisions. */
  deadline: bigint;
  /** Discovery source, for logging. MUST NOT be used to gate claimability. */
  source: 'rpc' | 'indexer';
}

// ─── Task source interface ────────────────────────────────────────────────────

/**
 * Common interface for task-candidate providers.
 *
 * Each implementation is responsible for its own connection lifecycle.
 * The evaluation pipeline calls `start()` once and then `candidates()` on each
 * round. `stop()` is called on graceful shutdown.
 */
export interface TaskSource {
  /**
   * One-time initialisation. Implementations establish connections here rather
   * than in the constructor so errors surface in an async context.
   *
   * For IndexerTaskSource this opens the WebSocket and begins buffering events.
   * For RpcTaskSource this is a no-op.
   */
  start(): Promise<void>;

  /**
   * Return all candidate tasks discovered since the last call.
   *
   * For RpcTaskSource this scans the recent event window and returns the page.
   * For IndexerTaskSource this drains the internal buffer of events that have
   * arrived over the WebSocket since the last call.
   *
   * Calling `candidates()` before `start()` returns an empty array rather than
   * throwing, so callers do not need to track initialisation state themselves.
   */
  candidates(): Promise<CandidateTask[]>;

  /**
   * Release all held resources. Safe to call multiple times.
   */
  stop(): Promise<void>;

  /**
   * The source identifier used in log lines.
   */
  readonly kind: 'rpc' | 'indexer';
}

// ─── RPC task source (v1 behaviour) ──────────────────────────────────────────

/** Maximum symbol length for Soroban topic filters (mirrors v1's constant). */
const MAX_SYMBOL_LENGTH = 9;

/** Encode a symbol to the base64 XDR string getEvents expects, identical to
 *  v1's topicSymbol() so the filter always matches the emitted topic. */
function topicSymbol(name: string): string {
  if (name.length > MAX_SYMBOL_LENGTH) {
    throw new Error(`Symbol "${name}" is too long; max ${MAX_SYMBOL_LENGTH} chars`);
  }
  return nativeToScVal(name, { type: 'symbol' }).toXDR('base64');
}

/** Topic pair for TaskRegistered, from the contract's emit_task_registered. */
const TASK_REGISTERED_TOPICS = [topicSymbol('reg'), topicSymbol('task')];

/**
 * Lookback window (in ledgers) used when no cursor is available.
 * Matches v1's heuristic: ~1 000 ledgers ≈ ~83 minutes at 5-second ledgers.
 */
const DEFAULT_LOOKBACK_LEDGERS = 1000;

/**
 * RPC-backed task source.
 *
 * Reproduces v1's fetchPendingTasks behaviour with a persistent cursor so each
 * round only scans new ledgers rather than rescanning the full window. Preserves
 * all v1 error-handling conventions: failed getEvents → empty slice (logged),
 * malformed event → skip and count, first decode failure logged in full.
 */
export class RpcTaskSource implements TaskSource {
  readonly kind = 'rpc' as const;

  private readonly server: SorobanRpc.Server;
  private readonly contractId: string;
  /** Last fully-scanned ledger; used as startLedger on the next call. */
  private cursor: number | null = null;

  constructor(server: SorobanRpc.Server, contractId: string) {
    this.server = server;
    this.contractId = contractId;
  }

  async start(): Promise<void> {
    // No-op: the RPC server is already constructed and connected lazily.
  }

  async candidates(): Promise<CandidateTask[]> {
    let startLedger: number;

    if (this.cursor !== null) {
      // Advance by 1 so we do not re-scan the ledger we already processed.
      startLedger = this.cursor + 1;
    } else {
      // First call: use the lookback window.
      try {
        const latest = await this.server.getLatestLedger();
        startLedger = Math.max(1, latest.sequence - DEFAULT_LOOKBACK_LEDGERS);
      } catch (err) {
        console.warn(
          `[task_source rpc] getLatestLedger failed, will retry next round: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    }

    let response: SorobanRpc.Api.GetEventsResponse;
    try {
      response = await this.server.getEvents({
        startLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
            topics: [TASK_REGISTERED_TOPICS],
          },
        ],
        limit: 100,
      });
    } catch (err) {
      console.warn(
        `[task_source rpc] getEvents failed, will retry next round: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    const tasks: CandidateTask[] = [];
    let skipped = 0;

    for (const event of response.events ?? []) {
      try {
        // TaskRegistered payload: (task_id: u64, owner: Address, reward: i128, deadline: u64)
        // Mirrors the contract's emit_task_registered; see contracts/keeper-registry/src/events.rs.
        const vals = (event.value as xdr.ScVal).value() as xdr.ScVal[];
        const [taskIdVal, , rewardVal, deadlineVal] = vals;
        const taskId = BigInt(scValToNative(taskIdVal) as bigint);
        const reward = BigInt(scValToNative(rewardVal) as bigint);
        const deadline = BigInt(scValToNative(deadlineVal) as bigint);
        tasks.push({ taskId, reward, deadline, source: 'rpc' });
      } catch (err) {
        skipped++;
        if (skipped === 1) {
          // Log the first decode failure in full; count the rest.
          console.warn(
            `[task_source rpc] Could not decode a TaskRegistered event: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (skipped > 1) {
      console.warn(
        `[task_source rpc] Skipped ${skipped} undecodable event(s) — the contract's event shape may have changed.`,
      );
    }

    // Advance the cursor to the latest ledger in this response so the next
    // call only scans new ledgers. We take latestLedger from the response
    // because that is already the node's view at the time of this call.
    if (response.latestLedger > startLedger) {
      this.cursor = response.latestLedger;
    } else if (tasks.length > 0 || this.cursor === null) {
      this.cursor = startLedger;
    }

    if (tasks.length > 0) {
      console.log(`[task_source rpc] Discovered ${tasks.length} candidate task(s) taskSource=rpc`);
    }

    return tasks;
  }

  async stop(): Promise<void> {
    // No-op: RPC server has no persistent connection to close.
  }
}

// ─── Indexer task source ──────────────────────────────────────────────────────

/**
 * Milliseconds between reconnection attempts, with doubling backoff.
 * Capped at MAX_RECONNECT_DELAY_MS to bound the wait on persistent failures.
 */
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** How long (ms) to wait for the server's `subscribed` handshake message
 *  before treating the connection as failed. */
const SUBSCRIBE_TIMEOUT_MS = 10_000;

/**
 * Shapes the indexer WebSocket server can send.
 * Mirrors the Rust ServerMessage enum in indexer/src/api/websocket.rs.
 */
type ServerMessage =
  | {
      kind: 'subscribed';
      event_type: string | null;
      address: string | null;
      replayed_through: number | null;
    }
  | { kind: 'event'; event: IndexedEvent }
  | { kind: 'closed'; reason: string };

/** Minimal representation of the indexer's IndexedEvent, carrying only the
 *  fields the keeper bot needs. The rest is ignored without error so a future
 *  indexer schema addition does not break this client. */
interface IndexedEvent {
  cursor: number;
  event_type: string;
  payload: IndexedEventPayload;
}

/** Only the TaskRegistered variant is consumed; all others are skipped. */
interface IndexedEventPayload {
  type: string;
  task_id?: number;
  owner?: string;
  /** i128 serialised as a decimal string (may exceed Number.MAX_SAFE_INTEGER). */
  reward?: string;
  deadline?: number;
}

/**
 * WebSocket factory type — injectable for testing.
 *
 * In production this is `ws.WebSocket`; in tests a FakeWebSocket class is
 * injected so no real network is required. The factory receives the full URL
 * string (with query parameters) and returns a ws-compatible WebSocket instance.
 */
export type WebSocketFactory = (url: string) => WebSocket;

/** Default factory: uses the `ws` package (safe on Node 18+). */
const defaultWebSocketFactory: WebSocketFactory = (url: string) => new WebSocket(url);

/**
 * Indexer-backed task source.
 *
 * Subscribes to the indexer WebSocket feed filtered to `task_registered` events.
 * Incoming events are buffered internally; `candidates()` drains and returns
 * that buffer on each evaluation round.
 *
 * De-duplication: every task_id is tracked in a Set so a reconnection replay or
 * burst of duplicate messages does not cause the same task to enter the
 * evaluation pipeline twice. The Set is bounded by MAX_SEEN_TASK_IDS.
 *
 * Reconnection: an exponential-backoff loop re-establishes the WebSocket and
 * re-subscribes after any disconnect. The bot continues functioning while the
 * connection is down because `candidates()` simply returns the buffer as-is
 * (possibly empty) and is called again on the next round.
 *
 * REST API: the REST base URL is accepted so the implementation can optionally
 * query task metadata (e.g. current reward after an increase). Currently the WS
 * payload carries sufficient data for candidate creation, so REST is unused in
 * the initial implementation but the URL is threaded through so a follow-up PR
 * can add it without a config change.
 */
export class IndexerTaskSource implements TaskSource {
  readonly kind = 'indexer' as const;

  private readonly wsUrl: string;
  /** REST base URL, accepted but not currently queried — reserved for metadata
   *  enrichment in a follow-up. Prefixed _ to satisfy the noUnusedParameters
   *  rule while keeping the field for future use. */
  private readonly _restUrl: string;

  /** Tasks discovered but not yet returned by candidates(). */
  private readonly buffer: CandidateTask[] = [];

  /**
   * Set of task_ids already emitted (or currently buffered) so duplicates
   * from reconnection replays or burst messages are discarded immediately.
   *
   * Bounded to avoid unbounded growth on long-running bots. When the limit is
   * reached the oldest entry is evicted (FIFO via a secondary queue).
   */
  private readonly seenIds = new Set<bigint>();
  private readonly seenQueue: bigint[] = [];
  static readonly MAX_SEEN_TASK_IDS = 10_000;

  /** Tracks the last cursor received so reconnection can request a replay. */
  private lastCursor: number | null = null;

  /** Abort signal — set when stop() is called to prevent reconnection. */
  private stopped = false;

  /** Current WebSocket instance. */
  private ws: WebSocket | null = null;

  /** Current reconnect delay; doubled on each failed attempt, capped. */
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;

  /** WebSocket factory — swapped in tests. */
  private readonly wsFactory: WebSocketFactory;

  constructor(wsUrl: string, restUrl: string, wsFactory: WebSocketFactory = defaultWebSocketFactory) {
    this.wsUrl = wsUrl;
    this._restUrl = restUrl;
    this.wsFactory = wsFactory;
  }

  async start(): Promise<void> {
    console.log(
      `[task_source indexer] Starting indexer task source taskSource=indexer wsUrl=${sanitiseUrl(this.wsUrl)}`,
    );
    await this.connect();
  }

  async candidates(): Promise<CandidateTask[]> {
    // Drain the internal buffer atomically: splice to a local array, return it.
    const batch = this.buffer.splice(0);
    if (batch.length > 0) {
      console.log(
        `[task_source indexer] Delivering ${batch.length} buffered candidate task(s) taskSource=indexer`,
      );
    }
    return batch;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.ws) {
      try {
        this.ws.close(1000, 'bot shutdown');
      } catch {
        // ignore errors on close
      }
      this.ws = null;
    }
    console.log('[task_source indexer] Stopped taskSource=indexer');
  }

  // ── Internal WebSocket lifecycle ──────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const subscribeUrl = buildSubscribeUrl(this.wsUrl, this.lastCursor);

    console.log(
      `[task_source indexer] Connecting to indexer WebSocket taskSource=indexer url=${sanitiseUrl(subscribeUrl)}`,
    );

    return new Promise<void>((resolve, reject) => {
      let subscribed = false;

      const timeoutId = setTimeout(() => {
        if (!subscribed) {
          console.warn(
            '[task_source indexer] Timed out waiting for subscribed handshake taskSource=indexer',
          );
          ws.close();
          reject(new Error('subscribe timeout'));
        }
      }, SUBSCRIBE_TIMEOUT_MS);

      const ws = this.wsFactory(subscribeUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        console.log('[task_source indexer] WebSocket connection established taskSource=indexer');
      });

      ws.on('message', (data: WebSocket.RawData) => {
        const raw = data.toString();

        let msg: ServerMessage;
        try {
          msg = JSON.parse(raw) as ServerMessage;
        } catch {
          console.warn(
            '[task_source indexer] Received non-JSON message, ignoring taskSource=indexer',
          );
          return;
        }

        if (msg.kind === 'subscribed') {
          clearTimeout(timeoutId);
          subscribed = true;
          console.log(
            `[task_source indexer] Subscription active taskSource=indexer replayed_through=${msg.replayed_through ?? 'none'}`,
          );
          resolve();
        } else if (msg.kind === 'event') {
          this.handleEvent(msg.event);
        } else if (msg.kind === 'closed') {
          console.warn(
            `[task_source indexer] Server closed subscription reason="${msg.reason}" taskSource=indexer`,
          );
          // Reconnection is triggered by the 'close' event below.
        }
      });

      ws.on('error', (err: Error) => {
        console.warn(
          `[task_source indexer] WebSocket error: ${err.message} taskSource=indexer`,
        );
        // The 'close' event fires after 'error'; reconnection is handled there.
      });

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeoutId);
        this.ws = null;

        const reasonStr = reason.toString();

        if (!subscribed) {
          reject(new Error(`WebSocket closed before subscribed: code=${code} reason=${reasonStr}`));
          return;
        }

        if (this.stopped) return;

        console.warn(
          `[task_source indexer] WebSocket disconnected code=${code} — will reconnect in ${this.reconnectDelayMs}ms taskSource=indexer`,
        );
        void this.scheduleReconnect();
      });
    }).catch(async (err: unknown) => {
      if (this.stopped) return;
      console.warn(
        `[task_source indexer] Connection attempt failed: ${err instanceof Error ? err.message : String(err)} — will retry in ${this.reconnectDelayMs}ms taskSource=indexer`,
      );
      await this.scheduleReconnect();
    });
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.stopped) return;

    await sleep(this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);

    console.log(
      `[task_source indexer] Attempting reconnect taskSource=indexer after=${this.reconnectDelayMs}ms`,
    );
    await this.connect();
  }

  private handleEvent(event: IndexedEvent): void {
    if (event.event_type !== 'task_registered') {
      // Only TaskRegistered events drive candidate discovery.
      return;
    }

    const payload = event.payload;

    if (
      payload.task_id === undefined ||
      payload.reward === undefined ||
      payload.deadline === undefined
    ) {
      console.warn(
        `[task_source indexer] TaskRegistered event missing required fields, skipping taskSource=indexer cursor=${event.cursor}`,
      );
      return;
    }

    let taskId: bigint;
    let reward: bigint;
    let deadline: bigint;

    try {
      taskId = BigInt(payload.task_id);
      // reward is an i128 serialised as a decimal string by the indexer
      // (see indexer/src/events.rs I128 serialisation) — parse carefully.
      reward = BigInt(payload.reward);
      deadline = BigInt(payload.deadline);
    } catch (err) {
      console.warn(
        `[task_source indexer] Could not parse TaskRegistered payload fields, skipping taskSource=indexer cursor=${event.cursor}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // De-duplicate: discard tasks already in the buffer or previously returned.
    if (this.seenIds.has(taskId)) {
      return;
    }

    this.trackSeen(taskId);
    this.lastCursor = event.cursor;

    const candidate: CandidateTask = { taskId, reward, deadline, source: 'indexer' };
    this.buffer.push(candidate);

    console.log(
      `[task_source indexer] New candidate task discovered taskId=${taskId} taskSource=indexer cursor=${event.cursor}`,
    );
  }

  /** Track a task_id as seen, evicting the oldest entry if the set is full. */
  private trackSeen(taskId: bigint): void {
    if (this.seenIds.size >= IndexerTaskSource.MAX_SEEN_TASK_IDS) {
      const oldest = this.seenQueue.shift();
      if (oldest !== undefined) {
        this.seenIds.delete(oldest);
      }
    }
    this.seenIds.add(taskId);
    this.seenQueue.push(taskId);
  }
}

// ─── Source selection ─────────────────────────────────────────────────────────

/**
 * Select and construct the appropriate task source from config.
 *
 * IndexerTaskSource is chosen when both `indexerWsUrl` and `indexerRestUrl`
 * are set. A partial configuration (only one URL set) is treated as "not
 * configured" and falls back to RPC scanning, so a misconfigured environment
 * does not silently reduce task discovery to zero.
 *
 * @param config - The validated bot configuration.
 * @param server - Soroban RPC server (used by RpcTaskSource; not used by IndexerTaskSource).
 * @param wsFactory - Optional WebSocket factory (injectable for testing).
 * @returns The constructed TaskSource (not yet started — caller must call start()).
 */
export function createTaskSource(
  config: Pick<BotConfig, 'indexerWsUrl' | 'indexerRestUrl' | 'registryContractId'>,
  server: SorobanRpc.Server,
  wsFactory?: WebSocketFactory,
): TaskSource {
  if (config.indexerWsUrl !== null && config.indexerRestUrl !== null) {
    console.log(
      `[task_source] Selecting IndexerTaskSource taskSource=indexer wsUrl=${sanitiseUrl(config.indexerWsUrl)}`,
    );
    return new IndexerTaskSource(config.indexerWsUrl, config.indexerRestUrl, wsFactory);
  }

  if (config.indexerWsUrl !== null || config.indexerRestUrl !== null) {
    // Partial configuration — warn clearly rather than silently discarding it.
    console.warn(
      '[task_source] Partial indexer configuration: both INDEXER_WS_URL and INDEXER_REST_URL must be set to enable indexer mode. Falling back to RPC scanning. taskSource=rpc',
    );
  } else {
    console.log(
      '[task_source] No indexer configured, using RPC event scanning taskSource=rpc',
    );
  }

  return new RpcTaskSource(server, config.registryContractId);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Append the `?event_type=task_registered` filter and, when a cursor is
 * available, `&after=<cursor>` for reconnection replay.
 */
function buildSubscribeUrl(baseWsUrl: string, afterCursor: number | null): string {
  const url = new URL(baseWsUrl);
  url.searchParams.set('event_type', 'task_registered');
  if (afterCursor !== null) {
    url.searchParams.set('after', String(afterCursor));
  }
  return url.toString();
}

/**
 * Strip credentials from a URL before logging it.
 * Passwords / tokens in the userinfo component must not appear in log output.
 */
function sanitiseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    return raw;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
