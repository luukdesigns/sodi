import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { bytesToHex, keccak256 } from 'viem';

/**
 * Where large envelopes live. Only ciphertext is ever stored, and the on-chain hash makes any
 * tampering or rollback by the store detectable, so stores need no trust beyond availability.
 */
export interface BlobStore {
  put(envelope: Uint8Array): Promise<string>;
  get(location: string): Promise<Uint8Array>;
}

export class InMemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(envelope: Uint8Array) {
    const location = `mem://${keccak256(envelope)}`;
    this.blobs.set(location, envelope.slice());
    return location;
  }

  async get(location: string) {
    const b = this.blobs.get(location);
    if (!b) throw new Error(`blob not found: ${location}`);
    return b.slice();
  }
}

/** Content-addressed files in a directory. */
export class FileBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  async put(envelope: Uint8Array) {
    await mkdir(this.dir, { recursive: true });
    const name = keccak256(envelope).slice(2);
    await writeFile(join(this.dir, name), envelope);
    return `file://${name}`;
  }

  async get(location: string) {
    const name = location.replace(/^file:\/\//, '');
    if (!/^[0-9a-f]{64}$/.test(name)) throw new Error(`invalid location: ${location}`);
    return new Uint8Array(await readFile(join(this.dir, name)));
  }
}

/** Any HTTP blob service that accepts PUT and serves GET by key (S3-style, an IPFS gateway, …). */
export class HttpBlobStore implements BlobStore {
  constructor(private readonly baseUrl: string) {}

  async put(envelope: Uint8Array) {
    const key = keccak256(envelope).slice(2);
    const url = new URL(key, this.baseUrl).toString();
    const res = await fetch(url, { method: 'PUT', body: new Blob([new Uint8Array(envelope)]) });
    if (!res.ok) throw new Error(`blob upload failed: ${res.status}`);
    return url;
  }

  async get(location: string) {
    const res = await fetch(location);
    if (!res.ok) throw new Error(`blob download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export { bytesToHex };
