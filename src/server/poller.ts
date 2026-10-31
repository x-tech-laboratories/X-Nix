// Runs each deployment's and cache's cycle on its own timer: every `interval`, or every `job_poll` while a long run is going.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { FastifyBaseLogger } from "fastify";

import type { Cache } from "./cache.ts";
import type { Deployment } from "./deployment.ts";

// What the poller drives; deployments and caches share one id space, so their timers never collide.
export interface Watched {
  readonly id: string;
  readonly settings: { interval: number; job_poll: number };
  cycle(options?: { force_eval?: boolean }): Promise<void>;
  busy(): boolean;
  // How soon a busy one is polled again, when sooner than its job_poll.
  poll_interval?(): number;
}

// ── Poller ───────────────────────────────────────────────────────────────────

export class Poller {
  readonly deployments: Map<string, Deployment>;
  readonly caches: Map<string, Cache>;
  // Anything else that follows long runs, such as the provisioner, each with an id no deployment or cache can take.
  private readonly others: Watched[];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly log: FastifyBaseLogger | null;
  private running = false;

  constructor(deployments: Deployment[], log: FastifyBaseLogger | null = null, caches: Cache[] = [], others: Watched[] = []) {
    this.deployments = new Map(deployments.map((deployment) => [deployment.id, deployment]));
    this.caches = new Map(caches.map((cache) => [cache.id, cache]));
    this.others = others;
    this.log = log;
  }

  private watched(): Watched[] {
    return [...this.deployments.values(), ...this.caches.values(), ...this.others];
  }

  start(): void {
    this.running = true;
    for (const watched of this.watched()) void this.tick(watched);
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // Runs a cycle now, as a person asking for fresh facts, and starts the timer over from it.
  async refresh(watched: Watched): Promise<void> {
    clearTimeout(this.timers.get(watched.id));
    await this.tick(watched, true);
  }

  // Polls soon after an action, so a started job's output shows up without waiting a whole interval.
  soon(watched: Watched): void {
    this.schedule(watched, 2);
  }

  private async tick(watched: Watched, force_eval = false): Promise<void> {
    try {
      await watched.cycle({ force_eval });
    } catch (error) {
      this.log?.error({ err: error, id: watched.id }, "Cycle failed");
    }
    this.schedule(watched, watched.busy() ? (watched.poll_interval?.() ?? watched.settings.job_poll) : watched.settings.interval);
  }

  private schedule(watched: Watched, delay_in_seconds: number): void {
    if (!this.running) return;
    clearTimeout(this.timers.get(watched.id));
    this.timers.set(watched.id, setTimeout(() => void this.tick(watched), delay_in_seconds * 1000));
  }
}
