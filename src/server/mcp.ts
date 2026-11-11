// X-Nix's routes as MCP tools at /api/mcp, so an AI client can read the fleet and act on it as the signed-in caller.
//
// Each tool runs its route inside the app with the caller's own sign-in, so a viewer's token can read and only an
// admin's can act. Installing onto a machine wipes its disks, so that is left to the page; so are file downloads.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { JsonSchema, ParamSpec } from "@x-tech-laboratories/x-libs/api_spec";
import { register_mcp_route, route_tools, type RouteToolSpec } from "@x-tech-laboratories/x-libs/server/mcp";
import type { FastifyInstance } from "fastify";

import { cache_action_ids } from "./cache.ts";
import { action_ids } from "./deployment.ts";
import { fleet_action_ids } from "./fleet.ts";
import { host_action_ids } from "./host.ts";
import { media_formats } from "./nixos/provision.ts";
import { metric_names } from "./store.ts";

// ── Arguments ────────────────────────────────────────────────────────────────

const text: JsonSchema = { type: "string", minLength: 1 };
const whole: JsonSchema = { type: "integer", minimum: 1 };
const epoch: JsonSchema = { type: "integer", minimum: 0, description: "Unix time in seconds" };

const one_of = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] });
const host: ParamSpec = { name: "name", schema: { ...text, description: "The host's name, as list_hosts gives it" } };
const flake: ParamSpec = { name: "id", schema: { ...text, description: "The flake's id, as list_flakes gives it" } };
const deployment: ParamSpec = { name: "id", schema: { ...text, description: "The deployment's id, as list_deployments gives it" } };
const cache: ParamSpec = { name: "id", schema: { ...text, description: "The cache's id, as list_caches gives it" } };

// ── Tools ────────────────────────────────────────────────────────────────────

export const routes: Record<string, RouteToolSpec> = {
  list_agents: { route: "GET /api/agents", description: "Lists each host with an agent key and whether its agent is connected now.", params: [] },

  list_hosts: { route: "GET /api/hosts", description: "Lists the watched hosts with their status, Nix store usage and boot entries.", params: [] },
  get_host: { route: "GET /api/hosts/:name", description: "Shows one host's status, Nix store usage and boot entries.", params: [host] },
  list_host_events: { route: "GET /api/hosts/:name/events", description: "Lists the history of what happened on one host, newest first.", params: [host] },
  refresh_host: { route: "POST /api/hosts/:name/refresh", description: "Reads a host's store and boot entries again now, and answers with the host.", params: [host] },
  run_host_action: {
    route: "POST /api/hosts/:name/actions/:action",
    description: "Runs an action on a host: collect frees space by collecting the Nix store's garbage, reboot restarts the machine.",
    params: [host, { name: "action", schema: one_of(host_action_ids) }],
  },
  set_next_boot: {
    route: "POST /api/hosts/:name/next-boot",
    description: "Sets the boot entry a host starts into once, from the entries get_host lists, and reboots into it now if reboot is true.",
    params: [host, { name: "entry", schema: text }, { name: "reboot", schema: { type: "boolean" }, optional: true }],
  },

  list_flakes: { route: "GET /api/flakes", description: "Lists the flakes the deployments build from, with their inputs, last update and why one cannot update.", params: [] },
  get_flake: { route: "GET /api/flakes/:id", description: "Shows one flake with its inputs, last update and why it cannot update.", params: [flake] },
  list_flake_events: { route: "GET /api/flakes/:id/events", description: "Lists the history of one flake, newest first.", params: [flake] },
  refresh_flake: { route: "POST /api/flakes/:id/refresh", description: "Reads a flake's metadata again now, and answers with the flake.", params: [flake] },
  update_flake: { route: "POST /api/flakes/:id/update", description: "Updates a flake's lock file and commits it, as its settings say.", params: [flake] },

  list_deployments: {
    route: "GET /api/deployments",
    description: "Lists every deployment, a NixOS configuration on one host, with what it runs, what the flake would build and whether they differ.",
    params: [],
  },
  get_deployment: { route: "GET /api/deployments/:id", description: "Shows one deployment: what it runs, what the flake would build and its pin.", params: [deployment] },
  list_deployment_events: { route: "GET /api/deployments/:id/events", description: "Lists the history of one deployment, newest first.", params: [deployment] },
  refresh_deployment: { route: "POST /api/deployments/:id/refresh", description: "Reads the host and evaluates the flake again now, and answers with the deployment.", params: [deployment] },
  run_deployment_action: {
    route: "POST /api/deployments/:id/actions/:action",
    description:
      "Runs an action on a deployment: build builds the new system, switch activates it now, boot makes it the default from the next boot, " +
      "test activates it until the next boot, dry-activate shows what switch would change, and reboot restarts the host.",
    params: [deployment, { name: "action", schema: one_of(action_ids) }],
  },
  pin_deployment: {
    route: "POST /api/deployments/:id/pin",
    description: "Fixes a deployment at a commit or tag; a null pin follows the branch head, and reset true goes back to the pin its settings give.",
    params: [deployment, { name: "pin", schema: { type: ["string", "null"] }, optional: true }, { name: "reset", schema: { type: "boolean" }, optional: true }],
  },
  diff_deployment: {
    route: "POST /api/deployments/:id/diff",
    description: "Lists the packages a switch would add, remove and change; force true compares again even when nothing changed since the last diff.",
    params: [deployment, { name: "force", schema: { type: "boolean" }, optional: true }],
  },
  list_generations: { route: "GET /api/deployments/:id/generations", description: "Lists the system generations on a deployment's host, marking the running one.", params: [deployment] },
  list_generation_sizes: { route: "GET /api/deployments/:id/generations/sizes", description: "Gives the closure size of each system generation on a deployment's host.", params: [deployment] },
  roll_back_deployment: {
    route: "POST /api/deployments/:id/rollback",
    description: "Activates an earlier system generation from list_generations, keeping the reason in the history.",
    params: [deployment, { name: "generation", schema: whole }, { name: "reason", schema: { type: "string", maxLength: 200 }, optional: true }],
  },
  get_closure: {
    route: "GET /api/deployments/:id/closure",
    description: "Gives a closure's dependency graph: which is current for the running system or target for what the flake builds, unless a generation number is given.",
    params: [deployment, { name: "which", schema: one_of(["current", "target"]), optional: true }, { name: "generation", schema: whole, optional: true }],
  },

  get_fleet: { route: "GET /api/fleet", description: "Shows the fleet settings, the tags deployments carry and the fleet runs so far.", params: [] },
  select_deployments: {
    route: "GET /api/fleet/select",
    description: "Lists the deployment ids a selector picks, such as \"web-* @canary\": names with * wildcards, and @tag for a tag.",
    params: [{ name: "selector", schema: text }],
  },
  start_fleet_run: {
    route: "POST /api/fleet/runs",
    description:
      "Runs an action on many deployments, picked by a selector or a list of ids, so many at a time; staged goes through the stage selectors in order, " +
      "stopping at the first failure.",
    params: [
      { name: "action", schema: one_of(fleet_action_ids) },
      { name: "selector", schema: text, optional: true },
      { name: "ids", schema: { type: "array", items: { type: "string" } }, optional: true },
      { name: "staged", schema: { type: "boolean" }, optional: true },
      { name: "stages", schema: { type: "array", items: { type: "string" } }, optional: true },
      { name: "parallel", schema: whole, optional: true },
    ],
  },
  get_fleet_run: { route: "GET /api/fleet/runs/:id", description: "Shows one fleet run and how far each deployment in it got.", params: [{ name: "id", schema: whole }] },
  stop_fleet_run: { route: "POST /api/fleet/runs/:id/stop", description: "Stops a fleet run from starting any more deployments.", params: [{ name: "id", schema: whole }] },

  list_caches: { route: "GET /api/caches", description: "Lists the binary caches with each target and whether it is built and pushed.", params: [] },
  get_cache: { route: "GET /api/caches/:id", description: "Shows one binary cache with each target and whether it is built and pushed.", params: [cache] },
  list_cache_events: { route: "GET /api/caches/:id/events", description: "Lists the history of one cache, newest first.", params: [cache] },
  refresh_cache: { route: "POST /api/caches/:id/refresh", description: "Checks every target of a cache again now, and answers with the cache.", params: [cache] },
  build_all_targets: { route: "POST /api/caches/:id/build-all", description: "Builds every target of a cache in one job and pushes them.", params: [cache] },
  run_cache_action: {
    route: "POST /api/caches/:id/targets/:name/:action",
    description: "Runs an action on one target of a cache: build builds and pushes it, push only pushes what is built.",
    params: [cache, { name: "name", schema: { ...text, description: "The target's name, as get_cache gives it" } }, { name: "action", schema: one_of(cache_action_ids) }],
  },

  get_provisioning: { route: "GET /api/provisioning", description: "Shows the installs, the install media built and the agent keys made for installed hosts.", params: [] },
  build_media: {
    route: "POST /api/provisioning/media",
    description: "Builds install media for a deployment's flake and configuration, or for a flake and configuration named.",
    params: [
      { name: "format", schema: one_of(media_formats) },
      { name: "deployment", schema: text, optional: true },
      { name: "flake", schema: text, optional: true },
      { name: "configuration", schema: text, optional: true },
    ],
  },
  remove_media: { route: "POST /api/provisioning/media/:id/remove", description: "Removes built install media, by the id get_provisioning gives.", params: [{ name: "id", schema: whole }] },
  forget_agent: {
    route: "POST /api/provisioning/agents/:host/forget",
    description: "Stops accepting the agent key X-Nix made for an installed host.",
    params: [{ name: "host", schema: text }],
  },

  list_jobs: {
    route: "GET /api/jobs",
    description: "Lists jobs, newest first: builds, switches, updates and every other command run, with how each ended. evaluations 1 includes flake evaluations.",
    params: [
      { name: "deployment", schema: text, optional: true },
      { name: "kind", schema: text, optional: true },
      { name: "evaluations", schema: one_of(["1"]), optional: true },
      { name: "since", schema: epoch, optional: true },
      { name: "limit", schema: whole, optional: true },
    ],
  },
  get_job: { route: "GET /api/jobs/:id", description: "Shows one job with its command and output.", params: [{ name: "id", schema: whole }] },
  list_samples: {
    route: "GET /api/samples",
    description: "Lists readings over time, comma-separated metrics from " + metric_names.join(", ") + ", for one owner or everyone.",
    params: [{ name: "metrics", schema: text }, { name: "owner", schema: text, optional: true }, { name: "since", schema: epoch, optional: true }],
  },
  list_builds: {
    route: "GET /api/builds",
    description: "Lists finished builds, newest first, with their products, and every target built so far.",
    params: [{ name: "owner", schema: text, optional: true }, { name: "target", schema: text, optional: true }, { name: "limit", schema: whole, optional: true }],
  },
};

const instructions =
  "X-Nix watches NixOS machines. A host is a machine; a deployment is one NixOS configuration on a host, built from a flake; " +
  "a cache is a binary cache it builds targets for. Look things up with the list_ and get_ tools first, then act by id. " +
  "Actions start jobs and answer at once; follow one with get_job. Times are Unix seconds.";

// ── Route ────────────────────────────────────────────────────────────────────

export async function register_mcp(app: FastifyInstance, version: string): Promise<void> {
  await app.register(async (scope) => register_mcp_route(scope, { name: "x-nix", version, instructions, ...route_tools(app, routes) }), { prefix: "/api" });
}
