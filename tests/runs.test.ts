import { describe, expect, it } from "vitest";

import { most_polls_per_follow } from "@x-tech-laboratories/x-libs/server/runs";

import { AgentPool, type LongRunPoll } from "../src/server/agents/agent.ts";
import { follow } from "../src/server/runs.ts";
import { Store } from "../src/server/store.ts";
import { clock, FakeAgent } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

// An agent that answers each poll with at most one character, or with a reply a test sets in its place.
class SlowAgent extends FakeAgent {
  reply_in_place: unknown = null;

  override async poll(run_id: string, offset: number): Promise<LongRunPoll> {
    if (this.reply_in_place !== null) return this.reply_in_place as LongRunPoll;
    const answer = await super.poll(run_id, offset);
    const new_output = answer.new_output.slice(0, 1);
    return { ...answer, new_output, next_offset: offset + new_output.length };
  }
}

// A running job following a run the agent has started.
async function running_job(agent: SlowAgent) {
  const store = new Store(":memory:");
  const agents = new AgentPool("host", agent);
  await agent.start("run-1", { kind: "programs", steps: [{ argv: ["true"] }] });
  const job_id = store.create_job({ deployment_id: "host-deploy", kind: "build", command: "{}", agent: null, run_id: "run-1", trigger: "manual", started_epoch: clock.now });
  return { store, agents, run: agent.last_run()!, job: () => store.job(job_id)! };
}

// ── Following ────────────────────────────────────────────────────────────────

describe("following a run", () => {
  it("carries on from the stored offset when one follow reaches its limit of polls", async () => {
    const agent = new SlowAgent();
    const { store, agents, run, job } = await running_job(agent);
    const output = "x".repeat(most_polls_per_follow + 10);
    agent.end(run, output, 0);
    const now = () => clock.now;

    const first = await follow(store, agents, job(), now);
    const offset_after_first = job().output_offset;
    const second = await follow(store, agents, job(), now);

    expect(first.outcome).toBe("running");
    expect(offset_after_first).toBe(most_polls_per_follow);
    expect(second.outcome).toBe("ended");
    expect(job()).toMatchObject({ state: "succeeded", output });
  });

  it("leaves the job running on a malformed reply, and finishes it once the replies are sound again", async () => {
    const agent = new SlowAgent();
    const { store, agents, run, job } = await running_job(agent);
    agent.end(run, "a", 0);
    agent.reply_in_place = { state: "exited", alive: false, size: "lots" };
    const now = () => clock.now;

    const malformed = await follow(store, agents, job(), now);
    const state_after_malformed = job().state;
    agent.reply_in_place = null;
    const sound = await follow(store, agents, job(), now);

    expect(malformed).toEqual({ outcome: "unreachable", error: expect.stringContaining("malformed") });
    expect(state_after_malformed).toBe("running");
    expect(sound.outcome).toBe("ended");
    expect(job()).toMatchObject({ state: "succeeded", output: "a" });
  });
});
