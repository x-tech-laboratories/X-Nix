// Runs each deployment's cycle on its own timer: every `interval`, or every `job_poll` while a long run is going.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { FastifyBaseLogger } from "fastify";

import type { Deployment } from "./deployment.ts";

// ── Poller ───────────────────────────────────────────────────────────────────

export class Poller {
  readonly deployments: Map<string, Deployment>;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly log: FastifyBaseLogger | null;
  private running = false;

  constructor(deployments: Deployment[], log: FastifyBaseLogger | null = null) {
    this.deployments = new Map(deployments.map((deployment) => [deployment.id, deployment]));
    this.log = log;
  }

  start(): void {
    this.running = true;
    for (const deployment of this.deployments.values()) void this.tick(deployment);
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // Runs a cycle now, as a person asking for fresh facts, and starts the timer over from it.
  async refresh(deployment: Deployment): Promise<void> {
    clearTimeout(this.timers.get(deployment.id));
    await this.tick(deployment, true);
  }

  // Polls soon after an action, so a started job's output shows up without waiting a whole interval.
  soon(deployment: Deployment): void {
    this.schedule(deployment, 2);
  }

  private async tick(deployment: Deployment, force_eval = false): Promise<void> {
    try {
      await deployment.cycle({ force_eval });
    } catch (error) {
      this.log?.error({ err: error, deployment: deployment.id }, "Deployment cycle failed");
    }
    this.schedule(deployment, deployment.busy() ? deployment.settings.job_poll : deployment.settings.interval);
  }

  private schedule(deployment: Deployment, delay_in_seconds: number): void {
    if (!this.running) return;
    clearTimeout(this.timers.get(deployment.id));
    this.timers.set(deployment.id, setTimeout(() => void this.tick(deployment), delay_in_seconds * 1000));
  }
}
