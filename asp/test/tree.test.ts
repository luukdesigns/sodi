import { poseidon } from 'maci-crypto/build/ts/hashing.js';
import { describe, expect, it } from 'vitest';

import { associationSetDocument, computeRoot, documentCid, encodeDocument } from '../src/tree.js';

describe('association set tree', () => {
  it('is 0 when empty, so nothing is published', () => {
    expect(computeRoot([])).toBe(0n);
  });

  it('is the leaf itself for a single label (LeanIMT)', () => {
    expect(computeRoot([42n])).toBe(42n);
  });

  it('hashes pairs with Poseidon(2) and carries odd nodes up unhashed', () => {
    const h12 = poseidon([1n, 2n]);
    expect(computeRoot([1n, 2n])).toBe(h12);
    expect(computeRoot([1n, 2n, 3n])).toBe(poseidon([h12, 3n]));
    expect(computeRoot([1n, 2n, 3n, 4n])).toBe(poseidon([h12, poseidon([3n, 4n])]));
  });

  it('depends on insertion order', () => {
    expect(computeRoot([1n, 2n])).not.toBe(computeRoot([2n, 1n]));
  });
});

describe('association set document', () => {
  const doc = associationSetDocument(46630, '0xACa6B50b648a6f575a009DC7c97aBe62808869Ce', [1n, 2n]);

  it('records the root, labels and lower-cased entrypoint', () => {
    expect(doc.root).toBe(poseidon([1n, 2n]).toString());
    expect(doc.labels).toEqual(['1', '2']);
    expect(doc.entrypoint).toBe('0xaca6b50b648a6f575a009dc7c97abe62808869ce');
  });

  it('has a CIDv1 within the 32-64 characters the Entrypoint accepts', async () => {
    const cid = await documentCid(doc);
    expect(cid.startsWith('bafkrei')).toBe(true);
    expect(cid.length).toBeGreaterThanOrEqual(32);
    expect(cid.length).toBeLessThanOrEqual(64);
  });

  it('has a stable CID for the same content', async () => {
    const again = associationSetDocument(46630, '0xaca6b50b648a6f575a009dc7c97abe62808869ce', [1n, 2n]);
    expect(await documentCid(again)).toBe(await documentCid(doc));
    expect(new TextDecoder().decode(encodeDocument(doc))).not.toContain(' ');
  });
});
