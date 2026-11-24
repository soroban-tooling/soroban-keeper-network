import test from 'node:test';
import assert from 'node:assert/strict';
import { ConditionTemplateClient } from '../src/condition-template.ts';

test('Criterion 1: isMet returns true when observed metric crosses threshold', () => {
  const client = new ConditionTemplateClient();
  const taskId = 101n;
  client.setTaskThreshold(taskId, 1500n);

  client.updateMetricValue(taskId, 1200n);
  assert.equal(client.isMet(taskId), false, 'Should not be met when below threshold');

  client.updateMetricValue(taskId, 1500n);
  assert.equal(client.isMet(taskId), true, 'Should be met when equal to threshold');

  client.updateMetricValue(taskId, 2000n);
  assert.equal(client.isMet(taskId), true, 'Should be met when above threshold');
});

test('Criterion 2: Unconfigured task returns false without throwing', () => {
  const client = new ConditionTemplateClient();
  const unconfiguredTaskId = 999n;
  assert.equal(client.isMet(unconfiguredTaskId), false, 'Must return false for unconfigured task');
});
