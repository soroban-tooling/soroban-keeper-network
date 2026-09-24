/**
 * Tests for secret redaction utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  isSensitiveKey,
  redactConfig,
  appearsToBeSensitive,
  safeLogValue,
  createRedactedConfigDump,
} from './secrets.js';

describe('Secret Redaction', () => {
  describe('isSensitiveKey', () => {
    it('identifies secretKey as sensitive', () => {
      expect(isSensitiveKey('secretKey')).toBe(true);
    });

    it('identifies KEEPER_SECRET_KEY as sensitive', () => {
      expect(isSensitiveKey('KEEPER_SECRET_KEY')).toBe(true);
    });

    it('identifies apiKey as sensitive', () => {
      expect(isSensitiveKey('apiKey')).toBe(true);
    });

    it('identifies token as sensitive', () => {
      expect(isSensitiveKey('token')).toBe(true);
    });

    it('does not identify network as sensitive', () => {
      expect(isSensitiveKey('network')).toBe(false);
    });

    it('does not identify registryContractId as sensitive', () => {
      expect(isSensitiveKey('registryContractId')).toBe(false);
    });
  });

  describe('appearsToBeSensitive', () => {
    it('detects Stellar secret key format', () => {
      const stellarSecret = 'SBJ77RJFKD7J3L7RJJL3L3L3L3L3L3L3L3L3L3L3L3L3L3L3L3L3L3L3';
      expect(appearsToBeSensitive(stellarSecret)).toBe(true);
    });

    it('detects 64-char hex strings (likely private keys)', () => {
      const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(appearsToBeSensitive(hexKey)).toBe(true);
    });

    it('detects base64-like strings', () => {
      const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==';
      expect(appearsToBeSensitive(base64)).toBe(true);
    });

    it('does not detect short strings as sensitive', () => {
      expect(appearsToBeSensitive('testnet')).toBe(false);
    });

    it('does not detect non-string values as sensitive', () => {
      expect(appearsToBeSensitive(12345)).toBe(false);
      expect(appearsToBeSensitive(null)).toBe(false);
      expect(appearsToBeSensitive(undefined)).toBe(false);
    });
  });

  describe('redactConfig', () => {
    it('redacts secretKey values', () => {
      const config = { network: 'testnet', secretKey: 'S123...', registryContractId: 'C456...' };
      const redacted = redactConfig(config);

      expect(redacted.network).toBe('testnet');
      expect(redacted.secretKey).toBe('***REDACTED***');
      expect(redacted.registryContractId).toBe('C456...');
    });

    it('redacts nested objects', () => {
      const config = {
        network: 'testnet',
        secrets: {
          apiKey: 'key123',
          publicData: 'visible',
        },
      };
      const redacted = redactConfig(config);

      expect((redacted.secrets as Record<string, unknown>).apiKey).toBe('***REDACTED***');
      expect((redacted.secrets as Record<string, unknown>).publicData).toBe('visible');
    });

    it('redacts array elements', () => {
      const config = {
        tokens: [
          { name: 'token1', value: 'secret1' },
          { name: 'token2', value: 'secret2' },
        ],
      };
      const redacted = redactConfig(config);

      const tokens = redacted.tokens as Array<Record<string, unknown>>;
      expect(tokens[0].value).toBe('***REDACTED***');
      expect(tokens[1].value).toBe('***REDACTED***');
    });

    it('preserves non-object array elements', () => {
      const config = {
        items: ['a', 'b', 'c'],
      };
      const redacted = redactConfig(config);

      expect(redacted.items).toEqual(['a', 'b', 'c']);
    });

    it('handles multiple secret keys', () => {
      const config = {
        secretKey: 'S123...',
        apiKey: 'key456',
        token: 'tok789',
        publicKey: 'pub000',
      };
      const redacted = redactConfig(config);

      expect(redacted.secretKey).toBe('***REDACTED***');
      expect(redacted.apiKey).toBe('***REDACTED***');
      expect(redacted.token).toBe('***REDACTED***');
      expect(redacted.publicKey).toBe('pub000');
    });
  });

  describe('safeLogValue', () => {
    it('redacts values with sensitive keys', () => {
      expect(safeLogValue('secretKey', 'S123...')).toBe('***REDACTED***');
    });

    it('redacts values that appear to be secrets', () => {
      const stellarSecret = 'SBJ77RJFKD7J3L7RJJL3L3L3L3L3L3L3L3L3L3L3L3L3L3L3L3L3L3L3';
      expect(safeLogValue('someKey', stellarSecret)).toBe('***REDACTED***');
    });

    it('allows normal values with non-sensitive keys', () => {
      expect(safeLogValue('network', 'testnet')).toBe('testnet');
    });

    it('allows normal values even if they look like keys', () => {
      expect(safeLogValue('registryContractId', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4')).toBe(
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      );
    });
  });

  describe('createRedactedConfigDump', () => {
    it('creates a safe configuration dump', () => {
      const config = {
        network: 'testnet',
        registryContractId: 'C123...',
        secretKey: 'S456...',
        apiKey: 'key789',
        rpcUrl: 'https://soroban-testnet.stellar.org',
      };

      const dump = createRedactedConfigDump(config);

      expect(dump.network).toBe('testnet');
      expect(dump.registryContractId).toBe('C123...');
      expect(dump.secretKey).toBe('***REDACTED***');
      expect(dump.apiKey).toBe('***REDACTED***');
      expect(dump.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    });

    it('never leaks actual secrets in the output', () => {
      const secretKey = 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const config = {
        network: 'testnet',
        secretKey,
        other: 'data',
      };

      const dump = createRedactedConfigDump(config);
      const dumpStr = JSON.stringify(dump);

      // The actual secret should not appear in the dump
      expect(dumpStr).not.toContain(secretKey);
      // But the redaction marker should
      expect(dumpStr).toContain('***REDACTED***');
    });
  });

  describe('Security validation', () => {
    it('no secret ever appears unredacted in config dumps', () => {
      const configs = [
        { secretKey: 'S1234567890ABCDEF', network: 'testnet' },
        { apiKey: 'secret_key_12345', token: 'tok_xyz', publicKey: 'pub_abc' },
        { nested: { deepSecret: 'S987654321FEDCBA' } },
      ];

      for (const config of configs) {
        const dump = createRedactedConfigDump(config);
        const dumpStr = JSON.stringify(dump);

        // Should contain redaction markers
        expect(dumpStr).toContain('***REDACTED***');

        // Should not contain obvious secret patterns
        expect(dumpStr).not.toMatch(/S[A-Z2-7]{55}/);
      }
    });
  });
});
