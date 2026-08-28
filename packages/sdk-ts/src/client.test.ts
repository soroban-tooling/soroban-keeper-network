import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { xdr, SorobanRpc } from '@stellar/stellar-sdk'
import { KeeperRegistryClient } from './client'

// ── Mock Setup ─────────────────────────────────────────────────────────

// Mock @stellar/stellar-sdk module
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk')
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: vi.fn(),
      Api: {
        ...actual.SorobanRpc.Api,
        isSimulationError: vi.fn(),
        GetTransactionStatus: {
          NOT_FOUND: 'NOT_FOUND',
          SUCCESS: 'SUCCESS',
          FAILED: 'FAILED',
        },
      },
    },
  }
})

// Helper to create mock account
function createMockAccount() {
  return {
    accountId: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    sequenceNumber: '1234567890',
  }
}

// Helper to create mock simulation result
function createMockSimResult(retval?: xdr.ScVal) {
  return {
    result: {
      retval: retval || xdr.ScVal.scvVoid(),
    },
  }
}

// Helper to create mock submit result
function createMockSubmitResult(hash: string = 'mock-hash-123') {
  return {
    status: 'SUCCESS',
    hash,
  }
}

// Helper to create mock get transaction result
function createMockGetTxResult(
  status: string = 'SUCCESS',
  returnValue?: xdr.ScVal
) {
  return {
    status,
    returnValue: returnValue || xdr.ScVal.scvVoid(),
  }
}

describe('KeeperRegistryClient', () => {
  let mockServer: any
  let mockContract: any
  let mockTransaction: any
  let mockPreparedTx: any

  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks()

    // Setup mock transaction
    mockPreparedTx = {
      toXDR: vi.fn().mockReturnValue('mock-prepared-xdr'),
    }

    mockTransaction = {
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue(mockPreparedTx),
    }

    // Setup mock contract
    mockContract = {
      call: vi.fn().mockReturnValue({}),
    }

    // Setup mock server
    mockServer = {
      getAccount: vi.fn().mockResolvedValue(createMockAccount()),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    }

    // Mock the SorobanRpc.Server constructor
    const { SorobanRpc } = require('@stellar/stellar-sdk')
    SorobanRpc.Server.mockImplementation(() => mockServer)

    // Mock Contract constructor
    const { Contract } = require('@stellar/stellar-sdk')
    vi.mocked(Contract).mockImplementation(() => mockContract)

    // Mock TransactionBuilder
    const { TransactionBuilder } = require('@stellar/stellar-sdk')
    vi.mocked(TransactionBuilder).mockImplementation(() => mockTransaction)
    vi.mocked(TransactionBuilder).fromXDR = vi.fn().mockReturnValue({
      toXDR: vi.fn().mockReturnValue('mock-signed-xdr'),
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ── CONSTRUCTOR VALIDATION ─────────────────────────────────────────

  describe('Constructor Validation', () => {
    it('should create instance with valid config', () => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      expect(() => new KeeperRegistryClient(config)).not.toThrow()
    })

    it('should throw when contractId is missing', () => {
      const config = {
        contractId: '',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        'contractId is required and must be a string'
      )
    })

    it('should throw when contractId is not a string', () => {
      const config = {
        contractId: 123 as any,
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        'contractId is required and must be a string'
      )
    })

    it('should throw when contractId does not start with C', () => {
      const config = {
        contractId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ12345678',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        /Invalid contractId.*Expected a Stellar contract address starting with C/
      )
    })

    it('should throw when contractId has wrong length', () => {
      const config = {
        contractId: 'CSHORT',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        /Invalid contractId.*Expected a Stellar contract address starting with C/
      )
    })

    it('should throw when contractId contains invalid characters', () => {
      const config = {
        contractId: 'C1234567890123456789012345678901234567890123456789012345678',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        /Invalid contractId/
      )
    })

    it('should throw when rpcUrl is missing', () => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: '',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        'rpcUrl is required and must be a string'
      )
    })

    it('should throw when rpcUrl is not a string', () => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: 123 as any,
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        'rpcUrl is required and must be a string'
      )
    })

    it('should throw when rpcUrl is not a valid URL', () => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: 'not-a-valid-url',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        /Invalid rpcUrl.*Expected a valid URL/
      )
    })

    it('should throw when networkPassphrase is missing', () => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: '',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        'networkPassphrase is required and must be a string'
      )
    })

    it('should throw when networkPassphrase is not a string', () => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 123 as any,
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        'networkPassphrase is required and must be a string'
      )
    })

    it('should throw when networkPassphrase is only whitespace', () => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: '   ',
      }

      expect(() => new KeeperRegistryClient(config)).toThrow(
        'networkPassphrase cannot be empty'
      )
    })

    it('error message should mention the invalid contractId value', () => {
      const invalidId = 'INVALID123'
      const config = {
        contractId: invalidId,
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }

      try {
        new KeeperRegistryClient(config)
        expect.fail('Should have thrown')
      } catch (err: any) {
        expect(err.message).toContain(invalidId)
      }
    })
  })

  // ── READ PATH (mocked RPC) ─────────────────────────────────────────

  describe('readCall() - Read-only Path', () => {
    let client: KeeperRegistryClient

    beforeEach(() => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }
      client = new KeeperRegistryClient(config)
    })

    it('should call server.simulateTransaction', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(false)

      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )

      await client['readCall']({ method: 'test_method' })

      expect(mockServer.simulateTransaction).toHaveBeenCalled()
    })

    it('should return retval from simulation result', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(false)

      const mockRetval = xdr.ScVal.scvVoid()
      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult(mockRetval)
      )

      const result = await client['readCall']({ method: 'test_method' })

      expect(result).toBe(mockRetval)
    })

    it('should throw clear error when simulation fails', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(true)

      mockServer.simulateTransaction.mockResolvedValue({
        error: 'Contract execution failed',
      })

      await expect(client['readCall']({ method: 'test_method' })).rejects.toThrow(
        /Read call simulation failed for method "test_method"/
      )
    })

    it('should throw when retval is missing', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(false)

      mockServer.simulateTransaction.mockResolvedValue({
        result: {},
      })

      await expect(client['readCall']({ method: 'test_method' })).rejects.toThrow(
        /Read call returned no value for method "test_method"/
      )
    })

    it('should use correct method name', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(false)

      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )

      await client['readCall']({ method: 'keeper_balance' })

      expect(mockContract.call).toHaveBeenCalledWith('keeper_balance')
    })

    it('should pass args to contract call', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(false)

      const mockArg = xdr.ScVal.scvVoid()
      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )

      await client['readCall']({ method: 'test_method', args: [mockArg] })

      expect(mockContract.call).toHaveBeenCalledWith('test_method', mockArg)
    })

    it('should use configured networkPassphrase', async () => {
      const { SorobanRpc, TransactionBuilder } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(false)

      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )

      await client['readCall']({ method: 'test_method' })

      // Check that TransactionBuilder was called with correct passphrase
      expect(TransactionBuilder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          networkPassphrase: 'Test SDF Network ; September 2015',
        })
      )
    })

    it('should use configured rpcUrl', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(false)

      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )

      // We can verify this by checking that the server was created with the right URL
      expect(SorobanRpc.Server).toHaveBeenCalledWith(
        'https://soroban-testnet.stellar.org'
      )
    })
  })

  // ── WRITE PATH (mocked RPC) ────────────────────────────────────────

  describe('writeCall() - Mutating Path', () => {
    let client: KeeperRegistryClient
    let mockSigner: any

    beforeEach(() => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }
      client = new KeeperRegistryClient(config)

      mockSigner = vi.fn().mockResolvedValue('mock-signed-xdr')

      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(false)
    })

    it('should call simulateTransaction then sendTransaction', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult()
      )
      mockServer.getTransaction.mockResolvedValue(
        createMockGetTxResult('SUCCESS')
      )

      await client['writeCall']({
        method: 'claim_task',
        sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
        signer: mockSigner,
      })

      expect(mockServer.simulateTransaction).toHaveBeenCalled()
      expect(mockServer.sendTransaction).toHaveBeenCalled()
    })

    it('should call signer with prepared XDR', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult()
      )
      mockServer.getTransaction.mockResolvedValue(
        createMockGetTxResult('SUCCESS')
      )

      await client['writeCall']({
        method: 'claim_task',
        sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
        signer: mockSigner,
      })

      expect(mockSigner).toHaveBeenCalledWith('mock-prepared-xdr')
    })

    it('should poll for transaction confirmation', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult('hash-123')
      )

      // First call returns NOT_FOUND, second returns SUCCESS
      mockServer.getTransaction
        .mockResolvedValueOnce({
          status: 'NOT_FOUND',
        })
        .mockResolvedValueOnce(createMockGetTxResult('SUCCESS'))

      await client['writeCall']({
        method: 'claim_task',
        sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
        signer: mockSigner,
      })

      expect(mockServer.getTransaction).toHaveBeenCalledTimes(2)
      expect(mockServer.getTransaction).toHaveBeenCalledWith('hash-123')
    })

    it('should return transactionHash from submitted tx', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult('expected-hash')
      )
      mockServer.getTransaction.mockResolvedValue(
        createMockGetTxResult('SUCCESS')
      )

      const result = await client['writeCall']({
        method: 'claim_task',
        sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
        signer: mockSigner,
      })

      expect(result.transactionHash).toBe('expected-hash')
    })

    it('should throw when simulation fails', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(true)

      mockServer.simulateTransaction.mockResolvedValue({
        error: 'Contract execution failed',
      })

      await expect(
        client['writeCall']({
          method: 'claim_task',
          sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
          signer: mockSigner,
        })
      ).rejects.toThrow(/Write call simulation failed for method "claim_task"/)
    })

    it('should throw when submission fails', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: {
          toXDR: vi.fn().mockReturnValue('error-xdr'),
        },
      })

      await expect(
        client['writeCall']({
          method: 'claim_task',
          sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
          signer: mockSigner,
        })
      ).rejects.toThrow(/Write call submission failed for method "claim_task"/)
    })

    it('should throw when transaction fails on-chain', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult('hash-123')
      )
      mockServer.getTransaction.mockResolvedValue(
        createMockGetTxResult('FAILED')
      )

      await expect(
        client['writeCall']({
          method: 'claim_task',
          sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
          signer: mockSigner,
        })
      ).rejects.toThrow(/Write call failed on-chain/)
    })

    it('should throw when polling times out', async () => {
      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult('hash-123')
      )
      mockServer.getTransaction.mockResolvedValue({
        status: 'NOT_FOUND',
      })

      await expect(
        client['writeCall']({
          method: 'claim_task',
          sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
          signer: mockSigner,
        })
      ).rejects.toThrow(/Write call timed out waiting for confirmation/)
    })

    it('should use configured networkPassphrase', async () => {
      const { TransactionBuilder } = require('@stellar/stellar-sdk')

      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult()
      )
      mockServer.getTransaction.mockResolvedValue(
        createMockGetTxResult('SUCCESS')
      )

      await client['writeCall']({
        method: 'claim_task',
        sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
        signer: mockSigner,
      })

      expect(TransactionBuilder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          networkPassphrase: 'Test SDF Network ; September 2015',
        })
      )
    })

    it('should connect to configured rpcUrl', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')

      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult()
      )
      mockServer.getTransaction.mockResolvedValue(
        createMockGetTxResult('SUCCESS')
      )

      expect(SorobanRpc.Server).toHaveBeenCalledWith(
        'https://soroban-testnet.stellar.org'
      )
    })
  })

  // ── SHARED PLUMBING ────────────────────────────────────────────────

  describe('Shared Plumbing', () => {
    let client: KeeperRegistryClient

    beforeEach(() => {
      const config = {
        contractId: 'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }
      client = new KeeperRegistryClient(config)

      const { SorobanRpc } = require('@stellar/stellar-sdk')
      vi.mocked(SorobanRpc.Api.isSimulationError).mockReturnValue(false)
    })

    it('readCall and writeCall use same contract instance', async () => {
      const mockSigner = vi.fn().mockResolvedValue('mock-signed-xdr')

      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult()
      )
      mockServer.getTransaction.mockResolvedValue(
        createMockGetTxResult('SUCCESS')
      )

      // Call both read and write
      await client['readCall']({ method: 'keeper_balance' })
      await client['writeCall']({
        method: 'claim_task',
        sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
        signer: mockSigner,
      })

      // Both should use the same contract instance (call count increases)
      expect(mockContract.call).toHaveBeenCalledTimes(2)
    })

    it('both paths use configured networkPassphrase', async () => {
      const { TransactionBuilder } = require('@stellar/stellar-sdk')
      const mockSigner = vi.fn().mockResolvedValue('mock-signed-xdr')

      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult()
      )
      mockServer.getTransaction.mockResolvedValue(
        createMockGetTxResult('SUCCESS')
      )

      // Reset call count
      vi.clearAllMocks()

      // Call both paths
      await client['readCall']({ method: 'test' })
      await client['writeCall']({
        method: 'test',
        sourceAccount: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX7QWQO',
        signer: mockSigner,
      })

      // Both should pass the same passphrase
      const calls = vi.mocked(TransactionBuilder).mock.calls
      calls.forEach((call) => {
        expect(call[1]).toEqual(
          expect.objectContaining({
            networkPassphrase: 'Test SDF Network ; September 2015',
          })
        )
      })
    })

    it('both paths connect to configured rpcUrl', async () => {
      const { SorobanRpc } = require('@stellar/stellar-sdk')
      const mockSigner = vi.fn().mockResolvedValue('mock-signed-xdr')

      mockServer.simulateTransaction.mockResolvedValue(
        createMockSimResult()
      )
      mockServer.sendTransaction.mockResolvedValue(
        createMockSubmitResult()
      )
      mockServer.getTransaction.mockResolvedValue(
        createMockGetTxResult('SUCCESS')
      )

      // The server should have been created during client construction
      expect(SorobanRpc.Server).toHaveBeenCalledWith(
        'https://soroban-testnet.stellar.org'
      )
    })

    it('should provide public getters for configuration', () => {
      expect(client.getContractId()).toBe(
        'CBQHAJYJ7SXLW6MXSSNHFKM7TDZGZXJDXPJ4Y6XLTXKJ3FXOMXMSWVMU'
      )
      expect(client.getRpcUrl()).toBe('https://soroban-testnet.stellar.org')
      expect(client.getNetworkPassphrase()).toBe('Test SDF Network ; September 2015')
    })
  })
})
