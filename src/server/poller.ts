// Runs each flake's, deployment's and cache's cycle on its own timer: every `interval` (or its own idle interval), or every `job_poll` while a long run is going.
// Flakes, deployments and caches share one id space and hosts have their own, so their timers never collide.

// ── Imports ──────────────────────────────────────────────────────────────────

import { CyclePoller, type Watched } from "@x-tech-laboratories/x-libs/server/poller";
import type { FastifyBaseLogger } from "fastify";

import type { Cache } from "./cache.ts";
import type { Deployment } from "./deployment.ts";
import type { Flake } from "./flake.ts";
import type { Host } from "./host.ts";
import type { Store } from "./store.ts";

export type { Watched };

// ── Poller ───────────────────────────────────────────────────────────────────

export class Poller {
  readonly deployments: Map<string, Deployment>;
  readonly caches: Map<string, Cache>;
  readonly flakes: Map<string, Flake>;
  // By the name their agents answer to.
  readonly hosts: Map<string, Host>;
  // Anything else that follows long runs, such as the provisioner, each with an id no flake, deployment or cache can take.
  private readonly others: Watched[];
  private readonly cycles: CyclePoller;

  constructor(
    deployments: Deployment[], log: FastifyBaseLogger | null = null, caches: Cache[] = [], others: Watched[] = [], flakes: Flake[] = [], hosts: Host[] = [],
  ) {
    this.deployments = new Map(deployments.map((deployment) => [deployment.id, deployment]));
    this.caches = new Map(caches.map((cache) => [cache.id, cache]));
    this.flakes = new Map(flakes.map((flake) => [flake.id, flake]));
    this.hosts = new Map(hosts.map((host) => [host.name, host]));
    this.others = others;
    this.cycles = new CyclePoller(() => this.watched(), log);
  }

  private watched(): Watched[] {
    return [...this.hosts.values(), ...this.flakes.values(), ...this.deployments.values(), ...this.caches.values(), ...this.others];
  }

  start(): void {
    this.cycles.start();
  }

  stop(): void {
    this.cycles.stop();
  }

  // Runs a cycle now, as a person asking for fresh facts, and starts the timer over from it.
  refresh(watched: Watched): Promise<void> {
    return this.cycles.refresh(watched);
  }

  // Polls soon after an action, so a started job's output shows up without waiting a whole interval.
  soon(watched: Watched): void {
    this.cycles.soon(watched);
  }

  // Polls whatever owns each new job soon, as a cache whose build a deployment started would otherwise wait a whole interval.
  follow_new_jobs(store: Store): () => void {
    return store.on_job_created((owner_id) => {
      const owner = this.watched().find((watched) => watched.id === owner_id);
      if (owner !== undefined) this.soon(owner);
    });
  }
}
