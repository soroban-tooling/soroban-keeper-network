/**
 * Secret Redaction Utilities
 *
 * Centralizes secret redaction logic following the secret-hygiene discipline
 * established by v1's requireEnv (examples/keeper-bot/index.js).
 *
 * This ensures:
 * - Consistent redaction across all inspection output
 * - Safe-by-default patterns for marking fields as sensitive
 * - Prevention of accidental secret disclosure
 */

/**
 * List of configuration keys that should always be redacted from output.
 * Any configuration values with these keys will have their content replaced
 * with a placeholder.
 */
const SENSITIVE_KEYS = new Set([
  'secretKey',
  'secret_key',
  'KEEPER_SECRET_KEY',
  'keeperSecretKey',
  'signingKey',
  'signing_key',
  'SIGNING_KEY',
  'privateKey',
  'private_key',
  'PRIVATE_KEY',
  'token',
  'TOKEN',
  'apiKey',
  'API_KEY',
  'api_key',
  'password',
  'PASSWORD',
  'credential',
  'CREDENTIAL',
  'credentials',
  'CREDENTIALS',
  'secret',
  'SECRET',
  'authToken',
  'AUTH_TOKEN',
  'auth_token',
  'bearerToken',
  'BEARER_TOKEN',
  'bearer_token',
  'accessToken',
  'ACCESS_TOKEN',
  'access_token',
]);

const REDACTED_PLACEHOLDER = '***REDACTED***';

/**
 * Check if a configuration key should be redacted.
 *
 * @param key - The configuration key name
 * @returns true if the key represents sensitive information that should be redacted
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

/**
 * Recursively redact sensitive values in a configuration object.
 *
 * This function walks the entire object tree and replaces values
 * for any key marked as sensitive with the REDACTED_PLACEHOLDER.
 *
 * @param config - The configuration object to redact
 * @returns A new object with sensitive values replaced
 */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (isSensitiveKey(key)) {
      redacted[key] = REDACTED_PLACEHOLDER;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively redact nested objects
      redacted[key] = redactConfig(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      // Redact arrays of objects
      redacted[key] = value.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? redactConfig(item as Record<string, unknown>)
          : item,
      );
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Check if a string value appears to be a secret (used for heuristic detection).
 *
 * This catches values that look like secrets based on format:
 * - Stellar secret keys (start with S)
 * - Hex strings longer than a typical threshold
 * - Base64-encoded values
 *
 * @param value - The value to check
 * @returns true if the value appears to be a secret
 */
export function appearsToBeSensitive(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  // Stellar secret key format (Ed25519)
  if (value.startsWith('S') && value.length === 56) {
    return true;
  }

  // Very long hex strings (potential private keys)
  if (/^[0-9a-fA-F]{64,}$/.test(value)) {
    return true;
  }

  // Very long base64-looking strings
  if (/^[A-Za-z0-9+/]{80,}={0,2}$/.test(value)) {
    return true;
  }

  return false;
}

/**
 * Safely log a configuration value, redacting if it appears sensitive.
 *
 * This is a defensive helper for logging that applies heuristic redaction
 * to catch secrets that might have been logged with the wrong key name.
 *
 * @param key - The configuration key
 * @param value - The value to log
 * @returns A safe-to-log representation of the value
 */
export function safeLogValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key) || appearsToBeSensitive(value)) {
    return REDACTED_PLACEHOLDER;
  }
  return value;
}

/**
 * Create a redacted copy of a configuration object suitable for inspection output.
 *
 * This is the primary public API for configuration redaction. It ensures
 * that configuration dumps never leak secrets while remaining useful for
 * debugging.
 *
 * @param config - The configuration object to redact
 * @returns A new object safe to return to operators
 */
export function createRedactedConfigDump(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactConfig(config);
}
