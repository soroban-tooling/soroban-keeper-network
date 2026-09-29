# Keeper Bot v2 Security Review (E15)

This document records the pre-release security review for the **Keeper Bot v2**
architecture (Epic E15, Issue #414 / Backlog Issue 0286).

**Status:** Completed. Follows the security discipline established by Epic E14
(Indexer Security Pass, issue 0248) and Epic E04 (Verifier Security Analysis).

---

## 1. Executive Summary & Review Scope

Keeper Bot v1 (`examples/keeper-bot/index.js`) is an intentionally simple,
in-memory, single-process automation client. Version 2 expands the operational
capabilities to support production, high-availability, and competitive node
operators. These additions introduce new architectural surfaces:
1. **Durable Persistence & Database**: SQLite / PostgreSQL schema storing task
   lifecycle, candidate history, and outcome records (issue 0252).
2. **External Secret Management**: AWS Secrets Manager, Google Cloud Secret
   Manager, and HashiCorp Vault integrations for key custody (issue 0268).
3. **CLI Inspection & Diagnostic Interface**: IPC and administrative CLI commands
   to inspect in-flight candidate tasks, queue depths, and account states (issue 0265).
4. **Metrics & Telemetry Endpoint**: Prometheus `/metrics` HTTP server for
   operational monitoring (issue 0257).

This review examines each component against three primary attack vectors:
- **Vector 1**: Network exposure and credential/signing capability leakage via
  the CLI or metrics endpoints.
- **Vector 2**: Storage of proprietary execution strategies, task histories,
  or credentials in the persisted state schema without encryption at rest.
- **Vector 3**: Inadvertent leakage of plaintext private keys to disk, log streams,
  or swap during external secret manager resolution.

---

## 2. Review Findings & Threat Analysis

### 2.1 Concern 1: CLI Inspection Commands and Metrics / Admin Endpoint Leakage

#### The Threat
If an administrative inspection interface or telemetry endpoint binds to public
or wildcard network interfaces (`0.0.0.0`), unauthenticated network actors
could query internal state. Potential hazards include:
1. **Signing Capability Exploitation**: An administrative endpoint allowing
   arbitrary transaction signing or key manipulation.
2. **Private Key Disclosure**: Configuration dumps or diagnostic status queries
   that include raw secret keys (`KEEPER_SECRET_KEY`, RPC tokens, database passwords).
3. **Mempool & Strategy Front-Running**: Eavesdropping on pending claims or
   candidate tasks before on-chain broadcast.

#### Findings & Evaluation
- **Signing Capability**:
  *Finding: Does not apply to query interface.* The CLI inspection commands
  (issue 0265) are designed strictly as **read-only status queries** against the
  in-memory or SQLite database. The IPC handler exposes no RPC method to request
  signature creation or transaction submission.
- **Secret Exposure in Diagnostics**:
  *Finding: Real risk if configuration objects are serialized.* Commands such as
  `keeper-bot status --full` or `/debug/vars` would leak `KEEPER_SECRET_KEY` if
  they dump the runtime `CONFIG` object naively.
- **Network Interface Exposure**:
  *Finding: High severity if unmitigated.* Exposing an unauthenticated Prometheus
  endpoint on a public IP leaks queue state, wallet addresses, and execution rates.

#### Mandated Mitigations & Security Controls
1. **Loopback-Only Interface Binding**:
   - The CLI IPC server MUST default to local UNIX domain sockets (e.g.,
     `/var/run/keeper-bot.sock` with file permission `0600`) on POSIX systems, or
     strictly `127.0.0.1` on TCP.
   - Binding to `0.0.0.0` or any external IP must require an explicit, intentional
     flag `--insecure-allow-external-bind` and log a high-priority warning.
2. **Strict Configuration Sanitization**:
   - Diagnostic status commands MUST pass all environment and configuration
     properties through a redactor. Any key matching secret patterns
     (`*SECRET*`, `*KEY*`, `*TOKEN*`, `*PASSWORD*`) must be masked with
     `[REDACTED]`.
3. **Metrics Endpoint Isolation**:
   - The Prometheus `/metrics` endpoint MUST ONLY expose aggregate numeric
     counters, gauges, and histograms (e.g., `tasks_claimed_total`,
     `round_duration_seconds`).
   - Labels MUST NEVER include raw calldata, private keys, or operator credentials.
   - Optional HTTP Basic Authentication or Bearer Token auth MUST be supported
     for metrics scraping.

---

### 2.2 Concern 2: Persisted State Schema & Encryption at Rest

#### The Threat
Version 2 introduces a persistent task-state database (issue 0252) storing
in-flight claims, task execution attempts, and historical outcomes. An attacker
gaining read access to the database file or storage volume could:
1. Extract signing credentials if stored in the database.
2. Reconstruct the keeper's private bidding, profitability thresholds, and
   timing heuristics to gain a competitive advantage in task claiming.

#### Findings & Evaluation
- **Credential Storage**:
  *Finding: Confirmed does not apply.* Signing keys and API credentials MUST
  NEVER be written into the database schema. The database exists solely to track
  public task records (`task_id`, `status`, `claim_ledger`, `executed_tx_hash`).
- **Strategy & Timing Confidentiality**:
  *Finding: Low-to-Medium risk depending on deployment.* All task data stored
  in the database is ultimately derived from public Stellar/Soroban ledger
  events. However, local profitability calculations and retry back-off state
  reflect internal heuristics.

#### Mandated Mitigations & Security Controls
1. **Zero Secret Persistence**:
   - The database schema MUST NOT contain tables or columns for credentials,
     seed phrases, or secret keys. Automated tests must assert that no table
     definition stores keys.
2. **Database File Permissions**:
   - SQLite database files MUST be created with restricted POSIX permissions
     `0600` (readable and writable only by the bot process user).
3. **Optional SQLCipher / Full Disk Encryption (FDE)**:
   - For enterprise deployments requiring defense-in-depth against local data
     inspection, the database adapter MUST support encrypted SQLite connections
     (SQLCipher) or volume-level encryption (LUKS / AWS EBS Encryption).
4. **Data Retention & Pruning**:
   - Historical task records older than a configurable retention threshold (e.g.
     30 days) MUST be pruned automatically to limit storage exposure and disk
     exhaustion.

---

### 2.3 Concern 3: Secret Manager Integration & Zero Plaintext Leaking

#### The Threat
When integrating external secret managers (AWS Secrets Manager, GCP Secret
Manager, Vault - issue 0268), the bot fetches secret material over the network.
Common anti-patterns in Node.js applications include:
1. Writing fetched secrets to temporary `.env` or cache files on disk.
2. Echoing secret values into stdout/stderr via unhandled promise rejections,
   debug logging (`console.log(process.env)`), or Axios/HTTP error dumps.
3. Leaking secrets into error stack traces when API validation fails.

#### Findings & Evaluation
- **File System Caching**:
  *Finding: High severity if unmitigated.* Secret manager adapters must never
  write intermediate secrets to temporary files or local caches.
- **Log Stream Disclosure**:
  *Finding: High severity if unmitigated.* Standard logger frameworks dump
  request/response payloads on HTTP 4xx/5xx errors.
- **Error Propagation**:
  *Finding: Addressed in existing v1 test baseline.* `examples/keeper-bot/test/validation.test.js`
  already proves: `never includes secret key in error output`. This standard
  must be preserved in all v2 secret-manager modules.

#### Mandated Mitigations & Security Controls
1. **Direct In-Memory Hydration**:
   - Secrets retrieved from cloud secret managers MUST be held strictly in memory
     and passed directly to `@stellar/stellar-sdk`'s `Keypair.fromSecret()`.
   - Never write fetched secrets to `.env.local`, disk caches, or temp files.
2. **Global Secret Scrubber in Logger Transports**:
   - All logging transports (console, Winston, Pino) MUST integrate a regex-based
     sanitizer that scans log strings before output.
   - Any string matching the Stellar Secret Seed pattern (`^S[A-Z0-9]{55}$`)
     MUST be replaced immediately with `[REDACTED_STELLAR_KEY]`.
3. **Safe Exception Handling in External Adapters**:
   - HTTP clients querying AWS/Vault MUST disable raw body dumps in error logs.
   - On secret fetch failure, error messages MUST report generic metadata
     (e.g., `Failed to retrieve secret 'keeper/prod/key' from Vault: HTTP 403 Forbidden`)
     without dumping the response headers or token values.

---

## 3. Summary of Findings & Action Items

| ID | Category | Finding / Concern | Severity | Status / Resolution |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | CLI / Metrics | CLI commands or metrics port could leak keys if exposed on 0.0.0.0. | High | **Resolved**: Enforce 127.0.0.1 / UNIX socket default; redact all secrets from diagnostics; isolate Prometheus labels. |
| **SEC-02** | CLI / Metrics | Remote signing capability exposed via inspection interface. | Critical | **Resolved**: Inspection interface is strictly read-only query; no signing APIs permitted. |
| **SEC-03** | Persistence | Persistent state schema leaks secret keys. | Critical | **Resolved**: Database schema strictly holds public task state; zero secrets persisted. |
| **SEC-04** | Persistence | Unencrypted state reveals execution timing / strategies. | Low | **Resolved**: Recommend SQLCipher or volume-level LUKS encryption for operators requiring confidentiality; restrict file to `0600`. |
| **SEC-05** | Secret Manager | Plaintext secret keys written to disk or logs during resolution. | High | **Resolved**: Strict in-memory hydration only; global Stellar secret regex scrubber on all logger transports. |
| **SEC-06** | Secret Manager | Startup error dumps cloud provider responses containing credentials. | Medium | **Resolved**: Guard secret-manager error handlers to log error status codes without body reflection. |

---

## 4. Verification & Follow-up Plan

1. **Automated Security Tests**:
   - Run `npm test` verifying that secret validation errors never reflect keys
     (`test/validation.test.js`).
   - Add automated test assertions verifying that logger streams scrub secret keys.
2. **Follow-Up Scoped Issues**:
   - Issue 0268 implementation MUST verify zero file emission during Vault/AWS pulls.
   - Issue 0265 implementation MUST assert UNIX socket / localhost-only binding in unit tests.
