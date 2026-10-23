import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { keyDerivationMessage, keyPairFromSignature } from '@sodi/a2a';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { FileBlobStore, InMemoryBlobStore } from '../../src/blobs.js';
import { deriveMemoryKey, deriveNamespaceSalt, privateNamespace, publicNamespace } from '../../src/keys.js';

const wallet = (k: `0x${string}`) =>
  createWalletClient({ account: privateKeyToAccount(k), transport: http('http://127.0.0.1:1') });
const sage = wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const juno = wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

describe('memory keys', () => {
  it('are stable for a wallet and epoch', async () => {
    expect((await deriveMemoryKey(sage, 1)).publicKey).toBe((await deriveMemoryKey(sage, 1)).publicKey);
  });

  it('change with every epoch', async () => {
    expect((await deriveMemoryKey(sage, 1)).publicKey).not.toBe((await deriveMemoryKey(sage, 2)).publicKey);
  });

  it('are independent of the messaging key', async () => {
    const messaging = keyPairFromSignature(
      await sage.signMessage({ account: sage.account, message: keyDerivationMessage(sage.account.address) }),
    );
    expect((await deriveMemoryKey(sage, 1)).publicKey).not.toBe(messaging.publicKey);
  });

  it('reject invalid epochs', async () => {
    await expect(deriveMemoryKey(sage, 0)).rejects.toThrow(/epoch/);
  });
});

describe('slot ids', () => {
  it('hide names behind a per-agent salt', async () => {
    const [s1, s2] = await Promise.all([deriveNamespaceSalt(sage), deriveNamespaceSalt(juno)]);
    expect(privateNamespace(s1, 'portfolio')).toBe(privateNamespace(s1, 'portfolio'));
    expect(privateNamespace(s1, 'portfolio')).not.toBe(privateNamespace(s2, 'portfolio'));
    // Guessing the name without the salt does not reveal the slot.
    expect(privateNamespace(s1, 'portfolio')).not.toBe(publicNamespace('portfolio'));
  });
});

describe('blob stores', () => {
  const blob = new Uint8Array([0xa2, 0x01, 1, 2, 3]);

  it('round-trip in memory', async () => {
    const s = new InMemoryBlobStore();
    expect(await s.get(await s.put(blob))).toEqual(blob);
  });

  it('round-trip on disk and refuse path tricks', async () => {
    const s = new FileBlobStore(mkdtempSync(join(tmpdir(), 'sodi-blobs-')));
    expect(await s.get(await s.put(blob))).toEqual(blob);
    await expect(s.get('file://../../etc/passwd')).rejects.toThrow(/invalid location/);
  });
});
