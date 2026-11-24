import { createHash } from 'node:crypto';

export interface VerifierRecord {
  taskId: bigint;
  expectedHashHex: string;
}

export class HashPreimageVerifierClient {
  private registry = new Map<string, string>(); // taskId string -> expectedHashHex

  /**
   * Set the expected SHA-256 hash for a given task ID.
   */
  setExpectedHash(taskId: bigint, expectedHashHex: string): void {
    this.registry.set(taskId.toString(), expectedHashHex.toLowerCase().replace(/^0x/, ''));
  }

  /**
   * Helper to set expected hash from a known preimage string or Buffer.
   */
  setExpectedPreimage(taskId: bigint, preimage: string | Buffer): string {
    const hash = createHash('sha256').update(preimage).digest('hex');
    this.setExpectedHash(taskId, hash);
    return hash;
  }

  /**
   * Implements IKeeperVerifier::verify(env, task_id, keeper, proof) -> bool
   * Execution is accepted only if the proof is the preimage of the hash set at registration.
   */
  verify(taskId: bigint, keeper: string, proof: Buffer): boolean {
    // Empty proof is strictly rejected
    if (!proof || proof.length === 0) {
      return false;
    }

    const expectedHash = this.registry.get(taskId.toString());
    if (!expectedHash) {
      return false;
    }

    const actualHash = createHash('sha256').update(proof).digest('hex');
    return actualHash === expectedHash;
  }
}
