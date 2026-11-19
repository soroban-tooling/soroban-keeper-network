import test from 'node:test';
import assert from 'node:assert/strict';
import { HashPreimageVerifierClient } from '../src/hash-preimage-verifier.ts';

test('Criterion 1: Correct proof is accepted', () => {
  const verifier = new HashPreimageVerifierClient();
  const taskId = 42n;
  const keeper = 'GD_KEEPER_TEST';
  const preimage = Buffer.from('valid_secret_computation_result_123');

  // Register expected hash
  const expectedHash = verifier.setExpectedPreimage(taskId, preimage);
  assert.ok(expectedHash);

  // Submit correct proof
  const isValid = verifier.verify(taskId, keeper, preimage);
  assert.equal(isValid, true, 'Verifier must return true for exact preimage');
});

test('Criterion 2: Wrong proof is rejected without panicking', () => {
  const verifier = new HashPreimageVerifierClient();
  const taskId = 42n;
  const keeper = 'GD_KEEPER_TEST';
  const validPreimage = Buffer.from('valid_secret_computation_result_123');
  const wrongPreimage = Buffer.from('invalid_forged_proof_from_adversary');

  verifier.setExpectedPreimage(taskId, validPreimage);

  // Submit wrong proof
  const isValid = verifier.verify(taskId, keeper, wrongPreimage);
  assert.equal(isValid, false, 'Verifier must return false for mismatching preimage');
});

test('Criterion 3: Empty proof is strictly rejected', () => {
  const verifier = new HashPreimageVerifierClient();
  const taskId = 42n;
  const keeper = 'GD_KEEPER_TEST';
  const validPreimage = Buffer.from('valid_secret_computation_result_123');

  verifier.setExpectedPreimage(taskId, validPreimage);

  // Submit empty proof
  const emptyProof = Buffer.alloc(0);
  const isValid = verifier.verify(taskId, keeper, emptyProof);
  assert.equal(isValid, false, 'Verifier must return false for empty proof');
});

test('Edge case: Unregistered task id returns false', () => {
  const verifier = new HashPreimageVerifierClient();
  const unconfiguredTaskId = 999n;
  const keeper = 'GD_KEEPER_TEST';
  const anyProof = Buffer.from('some_proof');

  const isValid = verifier.verify(unconfiguredTaskId, keeper, anyProof);
  assert.equal(isValid, false, 'Verifier must return false when no expected hash exists');
});
