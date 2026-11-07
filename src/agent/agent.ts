// The X-Nix agent: X-Libs' agent, which dials out over a WebSocket naming its host, signs the server's challenge with
// the host's key and dials again whenever it drops, performing each operation through the runner. With pull settings,
// it also deploys from Git on its own while the server is away, and reports those switches once the server is back.

// ── Imports ──────────────────────────────────────────────────────────────────

import { start_agent as start_x_libs_agent, type AgentConfig as XLibsAgentConfig } from "@x-tech-laboratories/x-libs/agent/client";
import type { LongRuns } from "@x-tech-laboratories/x-libs/agent/long_runs";
import type { AgentSession } from "@x-tech-laboratories/x-libs/agent/session";

import { x_nix_app } from "../shared/agent_protocol.ts";
import type { Operation } from "../shared/operations.ts";
import { Puller, type PullSettings } from "./pull.ts";
import { operation_runner } from "./tasks.ts";

export { AgentConfigError, check_url } from "@x-tech-laboratories/x-libs/agent/client";

// ── Settings ─────────────────────────────────────────────────────────────────

export interface AgentConfig extends Omit<XLibsAgentConfig<Operation>, "app" | "runner" | "token_file" | "key_file" | "on_hello" | "on_message"> {
  // The host's OpenSSH ed25519 private key.
  key_file: string;
  // Deploys from Git on its own once the server has been unreachable a while; off when absent.
  pull?: PullSettings;
}

export interface RunningAgent {
  readonly runs: LongRuns<Operation>;
  // Pull mode, when its settings were given.
  readonly puller: Puller | null;
  // Whether a session is open now.
  connected(): boolean;
  // Hangs up and stops dialling; long runs carry on.
  stop(): Promise<void>;
}

// ── Agent ────────────────────────────────────────────────────────────────────

export function start_agent(config: AgentConfig): RunningAgent {
  const { pull, ...rest } = config;
  const log = config.log ?? ((line: string) => console.log(line));
  let puller: Puller | null = null;

  // Sends the server every switch pull mode ran that it has not yet received.
  const report_pulls = async (session: AgentSession<Operation> | null) => {
    if (session === null || puller === null) return;
    const pulls = await puller.pending();
    if (pulls.length > 0) session.send({ type: "pulls", pulls });
  };

  const agent = start_x_libs_agent({
    ...rest,
    app: x_nix_app,
    runner: operation_runner,
    log,
    on_hello: (session) => void report_pulls(session),
    on_message: (message) => {
      if (message.type !== "pulls_received" || !Array.isArray(message.run_ids)) return;
      puller?.acknowledge(message.run_ids.filter((run_id): run_id is string => typeof run_id === "string"));
    },
  });

  puller = pull === undefined ? null : new Puller(pull, agent.runs, config.state_directory, {
    connected: agent.connected,
    report: () => void report_pulls(agent.session()),
    log,
  });
  puller?.start();

  return {
    runs: agent.runs,
    puller,
    connected: agent.connected,
    stop: () => {
      puller?.stop();
      return agent.stop();
    },
  };
}
