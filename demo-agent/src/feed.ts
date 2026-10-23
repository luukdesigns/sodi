/**
 * The demo agent's public activity feed. It holds only what the chain already shows, plus one thing
 * the chain doesn't: which sessions belong to this agent. That is the point of the demo: we tell you,
 * and you can check that nothing on-chain would have told you.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Address, Hex } from 'viem';

export type FeedEvent =
  | { kind: 'session'; at: number; session: Address; budget: string; fundingTx: Hex }
  | {
      kind: 'payment';
      at: number;
      api: string;
      amount: string;
      session: Address;
      payTo: Address;
      stealth: boolean;
      txHash?: Hex;
      result?: string;
    }
  | { kind: 'notice'; at: number; message: string };

export interface Feed {
  agent: { name: string; chainId: number; pool: Address; startedAt: number; intervalSeconds: number };
  events: FeedEvent[];
}

const MAX_EVENTS = 1000;

export class FeedLog {
  private feed: Feed;

  constructor(
    private readonly path: string | undefined,
    agent: Feed['agent'],
  ) {
    const old = path && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Feed) : undefined;
    this.feed = { agent, events: old?.events ?? [] };
  }

  add(e: FeedEvent): void {
    this.feed.events.push(e);
    if (this.feed.events.length > MAX_EVENTS) this.feed.events.splice(0, this.feed.events.length - MAX_EVENTS);
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.feed));
    renameSync(`${this.path}.tmp`, this.path);
  }

  /** Latest notice, so the same one isn't repeated every cycle. */
  lastNotice(): string | undefined {
    for (let i = this.feed.events.length - 1; i >= 0; i--) {
      const e = this.feed.events[i]!;
      if (e.kind === 'notice') return e.message;
      if (e.kind === 'payment') return undefined;
    }
    return undefined;
  }

  get(): Feed {
    return this.feed;
  }
}
