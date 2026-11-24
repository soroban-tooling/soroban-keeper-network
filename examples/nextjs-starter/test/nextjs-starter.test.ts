import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const baseDir = existsSync(join(process.cwd(), 'src'))
  ? process.cwd()
  : join(process.cwd(), 'examples/nextjs-starter');

test('Criterion 1: Uses only public SDK entry points', () => {
  const layoutContent = readFileSync(join(baseDir, 'src/app/layout.tsx'), 'utf-8');
  assert.ok(
    layoutContent.includes("from '@soroban-keeper-network/sdk/react'") ||
      layoutContent.includes('from "@soroban-keeper-network/sdk/react"'),
    'layout.tsx must import from public react entry point'
  );
  assert.ok(
    layoutContent.includes("from '@soroban-keeper-network/sdk'") ||
      layoutContent.includes('from "@soroban-keeper-network/sdk"'),
    'layout.tsx must import from public sdk entry point'
  );

  const formContent = readFileSync(
    join(baseDir, 'src/components/TaskRegisterForm.tsx'),
    'utf-8'
  );
  assert.ok(
    formContent.includes("from '@soroban-keeper-network/sdk/react'"),
    'TaskRegisterForm must import useRegisterTask from public entry point'
  );

  const trackerContent = readFileSync(
    join(baseDir, 'src/components/TaskTracker.tsx'),
    'utf-8'
  );
  assert.ok(
    trackerContent.includes("from '@soroban-keeper-network/sdk/react'"),
    'TaskTracker must import useTask and useTaskEvents from public entry point'
  );

  // Check no private internal paths like /src/ or /dist/ are imported
  assert.equal(layoutContent.includes('/src/'), false);
  assert.equal(formContent.includes('/src/'), false);
  assert.equal(trackerContent.includes('/src/'), false);
});

test('Criterion 2: Runs against testnet with documented environment variables', () => {
  const envExamplePath = join(baseDir, '.env.example');

  assert.ok(existsSync(envExamplePath), '.env.example must exist');
  const envContent = readFileSync(envExamplePath, 'utf-8');

  // Verify mandatory testnet variables are present
  assert.ok(envContent.includes('NEXT_PUBLIC_STELLAR_NETWORK=testnet'));
  assert.ok(envContent.includes('NEXT_PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org'));
  assert.ok(envContent.includes('NEXT_PUBLIC_NETWORK_PASSPHRASE='));
  assert.ok(envContent.includes('NEXT_PUBLIC_KEEPER_REGISTRY_ADDRESS='));
});
