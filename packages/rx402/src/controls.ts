import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Owner controls an agent obeys while it runs: a kill switch, spending caps and allowed hosts.
 * They are read before every payment, so a change (from the dashboard, or by editing the file)
 * takes effect on the next request without restarting the agent. They can only tighten the
 * agent's own policy, never loosen it.
 */
export interface Controls {
  /** Kill switch: refuse every payment. */
  paused: boolean;
  /** Cap per request, in asset base units. */
  maxPaymentAmount?: string;
  /** Cap on payments in any rolling 24 hours, in asset base units. */
  dailyLimit?: string;
  /** If non-empty, only these hosts may be paid. */
  allowedHosts?: string[];
  updatedAt?: number;
}

export interface ControlSource {
  load(): Controls;
}

export const defaultControls = (): Controls => ({ paused: false });

export class MemoryControls implements ControlSource {
  constructor(private controls: Controls = defaultControls()) {}
  load(): Controls {
    return structuredClone(this.controls);
  }
  save(controls: Controls): void {
    this.controls = structuredClone(controls);
  }
}

/**
 * Controls in a JSON file, written atomically. A file that can't be read fails closed: payments are
 * paused, because an owner who wrote a kill switch must not be ignored over a typo.
 */
export class FileControls implements ControlSource {
  constructor(readonly path: string) {}

  load(): Controls {
    if (!existsSync(this.path)) return defaultControls();
    try {
      const c = JSON.parse(readFileSync(this.path, 'utf8')) as Controls;
      // Anything but an explicit false (or no field at all) counts as paused.
      return { ...c, paused: c.paused === undefined ? false : c.paused !== false };
    } catch {
      return { paused: true };
    }
  }

  save(controls: Controls): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...controls, updatedAt: Math.floor(Date.now() / 1000) }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export type BlockReason = 'paused' | 'host-not-allowed' | 'over-request-cap' | 'over-daily-limit';

export class PaymentBlockedError extends Error {
  constructor(
    readonly reason: BlockReason,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentBlockedError';
  }
}
