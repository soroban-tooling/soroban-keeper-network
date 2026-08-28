import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  xdr,
  Address,
} from '@stellar/stellar-sdk'

// ── Types ──────────────────────────────────────────────────────────────

export interface KeeperRegistryClientConfig {
  contractId: string
  rpcUrl: string
  networkPassphrase: string
}

export interface SignerFn {
  (xdr: string): Promise<string>
}

export interface ReadCallOptions {
  method: string
  args?: xdr.ScVal[]
}

export interface WriteCallOptions extends ReadCallOptions {
  sourceAccount: string
  signer: SignerFn
}

export interface TransactionResult<T = xdr.ScVal> {
  result: T
  transactionHash: string
}

// ── Validation ─────────────────────────────────────────────────────────

const CONTRACT_ID_REGEX = /^C[A-Z0-9]{55}$/

function validateContractId(contractId: string): void {
  if (!contractId || typeof contractId !== 'string') {
    throw new Error('contractId is required and must be a string')
  }

  if (!CONTRACT_ID_REGEX.test(contractId)) {
    throw new Error(
      `Invalid contractId: "${contractId}". ` +
        'Expected a Stellar contract address starting with C (56 characters).'
    )
  }
}

function validateRpcUrl(rpcUrl: string): void {
  if (!rpcUrl || typeof rpcUrl !== 'string') {
    throw new Error('rpcUrl is required and must be a string')
  }

  try {
    new URL(rpcUrl)
  } catch {
    throw new Error(`Invalid rpcUrl: "${rpcUrl}". Expected a valid URL.`)
  }
}

function validateNetworkPassphrase(passphrase: string): void {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('networkPassphrase is required and must be a string')
  }

  if (passphrase.trim().length === 0) {
    throw new Error('networkPassphrase cannot be empty')
  }
}

// ── KeeperRegistryClient ───────────────────────────────────────────────

export class KeeperRegistryClient {
  private readonly contractId: string
  private readonly rpcUrl: string
  private readonly networkPassphrase: string
  private readonly server: SorobanRpc.Server
  private readonly contract: Contract

  constructor(config: KeeperRegistryClientConfig) {
    // Validate ALL inputs immediately — fail fast with clear errors
    validateContractId(config.contractId)
    validateRpcUrl(config.rpcUrl)
    validateNetworkPassphrase(config.networkPassphrase)

    this.contractId = config.contractId
    this.rpcUrl = config.rpcUrl
    this.networkPassphrase = config.networkPassphrase
    this.server = new SorobanRpc.Server(this.rpcUrl)
    this.contract = new Contract(this.contractId)
  }

  // ── Shared read-only path ──────────────────────────────────────────

  /**
   * Simulate a read-only contract call and return the result.
   * Does NOT require a signer or submit a transaction.
   * Mirrors readContract() from examples/keeper-bot/index.js
   */
  protected async readCall(options: ReadCallOptions): Promise<xdr.ScVal> {
    const account = await this.server.getAccount(
      // Use a dummy account for simulation — read calls don't need a real source
      'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'
    )

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(options.method, ...(options.args ?? []))
      )
      .setTimeout(30)
      .build()

    const simResult = await this.server.simulateTransaction(transaction)

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(
        `Read call simulation failed for method "${options.method}": ${simResult.error}`
      )
    }

    if (!simResult.result?.retval) {
      throw new Error(
        `Read call returned no value for method "${options.method}"`
      )
    }

    return simResult.result.retval
  }

  // ── Shared mutating path ───────────────────────────────────────────

  /**
   * Build, simulate, sign and submit a mutating contract call.
   * Requires a sourceAccount and signer function.
   * Mirrors invokeContract() from examples/keeper-bot/index.js
   */
  protected async writeCall(
    options: WriteCallOptions
  ): Promise<TransactionResult> {
    const account = await this.server.getAccount(options.sourceAccount)

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(options.method, ...(options.args ?? []))
      )
      .setTimeout(30)
      .build()

    // Simulate first
    const simResult = await this.server.simulateTransaction(transaction)

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(
        `Write call simulation failed for method "${options.method}": ${simResult.error}`
      )
    }

    // Assemble transaction with simulation results
    const preparedTx = SorobanRpc.assembleTransaction(
      transaction,
      simResult
    ).build()

    // Sign via provided signer function
    const signedXdr = await options.signer(preparedTx.toXDR())

    // Submit transaction
    const submitResult = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase)
    )

    if (submitResult.status === 'ERROR') {
      throw new Error(
        `Write call submission failed for method "${options.method}": ` +
          `${submitResult.errorResult?.toXDR() ?? 'unknown error'}`
      )
    }

    // Poll for confirmation
    const hash = submitResult.hash
    let getResult = await this.server.getTransaction(hash)
    let attempts = 0
    const MAX_ATTEMPTS = 30

    while (
      getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < MAX_ATTEMPTS
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      getResult = await this.server.getTransaction(hash)
      attempts++
    }

    if (attempts >= MAX_ATTEMPTS) {
      throw new Error(
        `Write call timed out waiting for confirmation: ${hash}`
      )
    }

    if (getResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(
        `Write call failed on-chain for method "${options.method}": ${hash}`
      )
    }

    return {
      result: getResult.returnValue ?? xdr.ScVal.scvVoid(),
      transactionHash: hash,
    }
  }

  // ── Public getters for subclasses ──────────────────────────────────

  getContractId(): string {
    return this.contractId
  }

  getRpcUrl(): string {
    return this.rpcUrl
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase
  }
}
