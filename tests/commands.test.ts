import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { build, cache_holds, evaluate, github_update, local_update } from "../src/agent/operations/deploy.ts";
import { perform } from "../src/agent/operations/index.ts";
import type { Context, ProgramOptions, ProgramResult, RunProgram } from "../src/agent/programs.ts";
import { ConfigError, deployment_settings, flake_settings, host_settings, parse_config } from "../src/server/config.ts";
import {
  build_operation, cache_holds_operation, cache_switch_steps, eval_operation, metadata_operation, post_switch_argv, rebuild_steps, split_eval_output,
  update_operation,
} from "../src/server/nixos/commands.ts";
import { github_repository, local_path, short_revision } from "../src/server/nixos/flake.ts";
import { generation_of, parse_probe, reboot_required } from "../src/server/nixos/probe.ts";
import { unfetchable_exit_code, type BuildOperation, type EvaluateOperation, type GithubUpdateOperation, type LocalUpdateOperation, type Operation } from "../src/shared/operations.ts";
import { current_closure, host_values } from "./fake_agent.ts";

// ── Setup ────────────────────────────────────────────────────────────────────

function settings(values: Record<string, unknown> = {}) {
  const [own, of_host] = host_values(values);
  return deployment_settings({ id: "odin-deploy", flake: "/etc/nixos", ...own }, 0, undefined, () => host_settings({ id: "odin", ...of_host }));
}

function flake(values: Record<string, unknown> = {}) {
  return flake_settings({ id: "config", url: "/etc/nixos", ...values });
}

const nix = ["nix", "--extra-experimental-features", "nix-command flakes"];

// A context whose programs answer what the test says, keeping every program run and everything shown.
function fake_context(answer: (argv: string[], options: ProgramOptions) => Partial<ProgramResult> = () => ({})) {
  const ran: string[][] = [];
  let output = "";
  const sink = { write: (chunk: Buffer | string) => void (output += chunk.toString()) };
  const shows = (use: string | undefined) => use === undefined || use === "show" || use === "both";
  const program: RunProgram = async (context, argv, options = {}) => {
    ran.push(argv);
    if (options.echo && context.log) context.out.write(`$ ${argv.join(" ")}\n`);
    const result = { exit_code: 0, stdout: "", stderr: "", ...answer(argv, options) };
    if (shows(options.stdout)) context.out.write(result.stdout);
    if (shows(options.stderr)) context.err.write(result.stderr);
    return result;
  };
  const context: Context = { out: sink, err: sink, signal: new AbortController().signal, own_groups: false, log: true, stdin: null, program };
  return { context, ran, output: () => output };
}

// The operation inside a timed wrapper.
function inner<Kind extends Operation>(operation: Operation): Kind {
  return (operation.kind === "timed" ? operation.operation : operation) as Kind;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

describe("the evaluation", () => {
  it("carries its own timeout", () => {
    const operation = eval_operation(settings({ eval_timeout: "5m" }), "host");

    expect(operation.seconds).toBe(300);
    expect(operation.operation.kind).toBe("evaluate");
  });

  it("refreshes a remote flake but not a local one", () => {
    expect(inner<EvaluateOperation>(eval_operation(settings(), "host")).refresh).toBe(false);
    expect(inner<EvaluateOperation>(eval_operation(settings({ flake: "github:owner/config" }), "host")).refresh).toBe(true);
  });

  it("never writes the lock file and evaluates the configured attribute", async () => {
    const { context, ran } = fake_context();

    await evaluate(context, inner<EvaluateOperation>(eval_operation(settings(), "ragnarok")));

    expect(ran.every((argv) => argv.includes("--no-write-lock-file"))).toBe(true);
    expect(ran[0].at(-1)).toBe('/etc/nixos#nixosConfigurations."ragnarok".config.system.build.toplevel');
  });

  it("splits back into the toplevel and the metadata when run", async () => {
    const { context, output } = fake_context((argv) => argv.includes("metadata")
      ? { stdout: '{"lastModified": 1}', stderr: "fetching" }
      : { stdout: current_closure, stderr: "evaluating" });

    const status = await evaluate(context, inner<EvaluateOperation>(eval_operation(settings(), "host")));
    const parts = split_eval_output(output(), "missing");

    expect(status).toBe(0);
    expect(parts.eval).toEqual({ exit_code: 0, stdout: current_closure, stderr: "evaluating" });
    expect(parts.metadata).toEqual({ exit_code: 0, stdout: '{"lastModified": 1}', stderr: "fetching" });
  });

  it("fails when either command does", async () => {
    const { context, output } = fake_context((argv) => (argv.includes("metadata") ? { exit_code: 1, stderr: "no network" } : { stdout: current_closure }));

    expect(await evaluate(context, inner<EvaluateOperation>(eval_operation(settings(), "host")))).toBe(1);
    expect(split_eval_output(output(), "missing").metadata).toEqual({ exit_code: 1, stdout: "", stderr: "no network" });
  });

  it("fails a command the run never reported on", () => {
    const parts = split_eval_output("@@x-nix-eval eval stderr\nkilled\n", "The evaluation ended before reporting");

    expect(parts.eval).toEqual({ exit_code: 1, stdout: "", stderr: "The evaluation ended before reporting" });
    expect(parts.metadata.exit_code).toBe(1);
  });
});

// ── Switch ───────────────────────────────────────────────────────────────────

describe("the switch", () => {
  const argv = (values: Record<string, unknown> = {}, mode: "switch" | "boot" = "switch") => rebuild_steps(settings({ build_progress: false, ...values }), mode)[0].argv;

  it("switches to the flake, naming the configuration when set", () => {
    expect(argv()).toEqual(["sudo", "-n", "nixos-rebuild", "switch", "--flake", "/etc/nixos"]);
    expect(argv({ configuration: "ragnarok" })).toContain("/etc/nixos#ragnarok");
    expect(argv({}, "boot")).toEqual(["sudo", "-n", "nixos-rebuild", "boot", "--flake", "/etc/nixos"]);
  });

  it("honours require_sudo and appends rebuild_args", () => {
    expect(argv({ require_sudo: false })).toEqual(["nixos-rebuild", "switch", "--flake", "/etc/nixos"]);
    expect(argv({ rebuild_args: ["--show-trace"] })).toContain("--show-trace");
  });

  it("sends compilation to build_host before rebuild_args, and activates on target_host", () => {
    expect(argv({ build_host: "root@builder", target_host: "root@odin", rebuild_args: ["--show-trace"] }).slice(-5))
      .toEqual(["--build-host", "root@builder", "--target-host", "root@odin", "--show-trace"]);
    expect(argv()).not.toContain("--build-host");
    expect(argv()).not.toContain("--target-host");
  });

  it("with build_progress, has nixos-rebuild print nix's structured log wherever it builds, without its own debug lines", () => {
    expect(argv({ build_progress: true, build_host: "root@builder", rebuild_args: ["--show-trace"] }).slice(-5))
      .toEqual(["--build-host", "root@builder", "--log-format", "internal-json", "--show-trace"]);
    expect(argv({ build_progress: true })).not.toContain("-v");
  });

  it("runs the wrapper outside sudo", () => {
    expect(argv({ switch_wrapper: ["systemd-inhibit", "--what=shutdown"] }))
      .toEqual(["systemd-inhibit", "--what=shutdown", "sudo", "-n", "nixos-rebuild", "switch", "--flake", "/etc/nixos"]);
  });

  it("runs post_switch as root under sudo, or as is without require_sudo", () => {
    expect(post_switch_argv(settings({ post_switch: "systemctl restart display-manager" })))
      .toEqual(["sudo", "-n", "/bin/sh", "-c", "systemctl restart display-manager"]);
    expect(post_switch_argv(settings({ require_sudo: false, post_switch: "true" }))).toEqual(["/bin/sh", "-c", "true"]);
    expect(post_switch_argv(settings())).toBeNull();
  });
});

describe("the switch from the cache", () => {
  const from_cache = { cache_url: "https://cache.example/fleet" };

  // The dry run exits 0 whatever it finds, as nix does, so only its output can fail the check.
  const holds = (plan: string, cache_has_top = true) => {
    const { context } = fake_context((argv) => (argv.includes("--store") ? { exit_code: cache_has_top ? 0 : 1 } : { stderr: plan }));
    return cache_holds(context, cache_holds_operation(settings(from_cache), current_closure));
  };

  it("holds a closure the host can fetch, taking from upstream what the cache left out", async () => {
    expect(await holds("these 1240 paths will be fetched (1.6 GiB download, 4.7 GiB unpacked):")).toBe(0);
    expect(await holds("")).toBe(0);
  });

  it("does not hold a closure with a path nothing can fetch, telling it from a system the cache lacks", async () => {
    expect(await holds("don't know how to build these paths:\n  /nix/store/00000000000000000000000000000000-bash")).toBe(unfetchable_exit_code);
    expect(await holds("these 2 derivations will be built:")).toBe(unfetchable_exit_code);
    expect(await holds("", false)).toBe(1);
  });

  it("fetches the closure, sets the system profile and activates it", () => {
    expect(cache_switch_steps(settings(from_cache), current_closure, "switch")).toEqual([
      { argv: [...nix, "build", "--no-link", "--log-format", "internal-json", "-v", current_closure] },
      { argv: [...nix, "path-info", "--recursive", current_closure], quiet: true },
      { argv: ["sudo", "-n", "nix-env", "-p", "/nix/var/nix/profiles/system", "--set", current_closure] },
      { argv: ["sudo", "-n", `${current_closure}/bin/switch-to-configuration`, "switch"] },
    ]);
    expect(cache_switch_steps(settings({ ...from_cache, build_progress: false }), current_closure, "switch")[0]).toEqual({ argv: [...nix, "build", "--no-link", current_closure] });
  });

  it("sets the system profile only in the modes that make a boot entry", () => {
    const activate = (mode: "boot" | "test" | "dry-activate") => cache_switch_steps(settings(from_cache), current_closure, mode).map((step) => step.argv.join(" "));

    expect(activate("boot").some((line) => line.includes("nix-env"))).toBe(true);
    expect(activate("boot").at(-1)).toBe(`sudo -n ${current_closure}/bin/switch-to-configuration boot`);
    expect(activate("test").some((line) => line.includes("nix-env"))).toBe(false);
    expect(activate("test").at(-1)).toBe(`sudo -n ${current_closure}/bin/switch-to-configuration test`);
    expect(activate("dry-activate").some((line) => line.includes("nix-env"))).toBe(false);
  });

  it("runs every step inside the wrapper", () => {
    const steps = cache_switch_steps(settings({ ...from_cache, switch_wrapper: ["systemd-inhibit", "--what=shutdown"] }), current_closure, "switch");

    expect(steps.every((step) => step.argv[0] === "systemd-inhibit" && step.argv[1] === "--what=shutdown")).toBe(true);
  });

  it("refuses anything but a store path", () => {
    expect(() => cache_switch_steps(settings(from_cache), "/nix/store/x; rm -rf /", "switch")).toThrow("not a store path");
    expect(() => cache_holds_operation(settings(from_cache), "/nix/store/x; rm -rf /")).toThrow("not a store path");
  });

});

// ── Build ────────────────────────────────────────────────────────────────────

describe("the build", () => {
  const run_build = async (operation: BuildOperation, answer: (argv: string[]) => Partial<ProgramResult> = () => ({})) => {
    const fake = fake_context(answer);
    const status = await build(fake.context, operation);
    return { status, ran: fake.ran, output: fake.output() };
  };

  it("realises this host's closure without activating it, going on past failures", async () => {
    const { ran } = await run_build(build_operation(settings({ flake: "github:owner/config", configuration: "ragnarok" }), "ragnarok"));

    expect(ran[0]).toContain("--no-link");
    expect(ran[0]).toContain("--keep-going");
    expect(ran[0]).toContain("--refresh");
    expect(ran[0].at(-1)).toBe('github:owner/config#nixosConfigurations."ragnarok".config.system.build.toplevel');
  });

  it("takes its arguments from build_args", () => {
    const operation = build_operation(settings({ build_args: ["--max-jobs", "2"], build_progress: false }), "host");

    expect(operation.args).toEqual(["--max-jobs", "2"]);
  });

  it("keeps one replaceable root per deployment under build_root_dir", () => {
    expect(build_operation(settings({ build_root_dir: "/var/lib/agent/build roots/" }), "host").root_link).toBe("/var/lib/agent/build roots/odin-deploy");
    expect(build_operation(settings(), "host").root_link).toBeNull();
  });

  it.each([
    { local: false, cached: true, builds: false },
    { local: true, cached: true, builds: true },
    { local: false, cached: false, builds: true },
  ])("skips a build the cache already holds (local $local, cached $cached)", async ({ local, cached, builds }) => {
    const { status, output } = await run_build(build_operation(settings({ cache_url: "https://cache.example/fleet" }), "host"), (argv) => {
      if (argv.includes("eval")) return { stdout: current_closure };
      if (argv.includes("--store")) return { exit_code: cached ? 0 : 1 };
      if (argv.includes("path-info")) return { exit_code: local ? 0 : 1 };
      return { stdout: "built\n" };
    });

    expect(status).toBe(0);
    expect(output.includes("built\n")).toBe(builds);
    expect(output.includes(`${current_closure} is already in the cache; not building it`)).toBe(!builds);
  });
});

// ── Update ───────────────────────────────────────────────────────────────────

describe("the update", () => {
  const github = { url: "github:owner/config", push_ssh_key: "/run/secrets/deploy_key" };

  const attributes = ['nixosConfigurations."odin".config.system.build.toplevel'];

  it("updates a local flake in place, unchecked when nothing names it or checks are off", () => {
    const in_place = { kind: "programs", steps: [{ argv: ["sudo", "-n", ...nix, "flake", "update", "--flake", "/etc/nixos", "--refresh"] }] };

    expect(update_operation(flake())).toEqual(in_place);
    expect(update_operation(flake({ check_update: "none" }), attributes)).toEqual(in_place);
  });

  it("checks a local flake's new lock before writing it, building with check_update build", () => {
    expect(update_operation(flake(), attributes)).toEqual({
      kind: "local_update", nix, path: "/etc/nixos", sudo: true, keep_nix_config: false, check: { attributes, build: false },
    });
    expect((update_operation(flake({ check_update: "build" }), attributes) as LocalUpdateOperation).check.build).toBe(true);
    expect(() => flake({ check_update: "sometimes" })).toThrow(ConfigError);
  });

  it("writes a local lock only once every attribute evaluates against it", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "x-nix-checkout-"));
    writeFileSync(join(checkout, "flake.lock"), "old");
    const operation = update_operation(flake({ url: checkout, require_sudo: false }), [...attributes, "packages.x86_64-linux.tool"]) as LocalUpdateOperation;
    // nix writes the new lock where it is told to.
    const lock_of = (argv: string[]) => (argv.includes("--output-lock-file") ? void writeFileSync(argv[argv.indexOf("--output-lock-file") + 1], "new") : undefined);
    const failing = fake_context((argv) => (lock_of(argv), argv.includes("eval") && argv.at(-1)!.includes("tool") ? { exit_code: 1 } : {}));

    expect(await local_update(failing.context, operation)).toBe(1);
    expect(failing.ran.filter((argv) => argv.includes("eval"))).toHaveLength(2);
    expect(failing.ran.some((argv) => argv[0] === "cp")).toBe(false);
    expect(failing.output()).toContain("The new lock breaks packages.x86_64-linux.tool");

    const passing = fake_context((argv) => lock_of(argv) ?? {});
    expect(await local_update(passing.context, operation)).toBe(0);
    const [update, check] = passing.ran;
    const new_lock = update[update.indexOf("--output-lock-file") + 1];
    expect(check).toEqual([...nix, "eval", "--raw", "--no-write-lock-file", "--reference-lock-file", new_lock, `${checkout}#${attributes[0]}.drvPath`]);
    expect(passing.ran.at(-1)).toEqual(["cp", "-T", new_lock, `${checkout}/flake.lock`]);
    rmSync(checkout, { recursive: true });
  });

  it("does not push a github: flake's lock that fails its check", async () => {
    const operation = update_operation(flake(github), attributes) as GithubUpdateOperation;
    const { context, ran, output } = fake_context((argv) => (argv.includes("diff") ? { exit_code: 1 } : argv.includes("eval") ? { exit_code: 1 } : {}));

    expect(await github_update(context, operation)).toBe(1);
    expect(ran.some((argv) => argv.includes("commit") || argv.includes("push"))).toBe(false);
    expect(output()).toContain("The new lock was not pushed");
  });

  it("updates a github: flake unprivileged, pushing over SSH with pinned host keys", async () => {
    const operation = update_operation(flake(github)) as GithubUpdateOperation;
    const environments: (string | undefined)[] = [];
    const { context, ran } = fake_context();
    const program = context.program;
    context.program = (inner_context, argv, options) => {
      environments.push(options?.env?.GIT_SSH_COMMAND);
      return program(inner_context, argv, options);
    };

    await github_update(context, operation);

    expect(operation.kind).toBe("github_update");
    expect(ran.some((argv) => argv.includes("sudo"))).toBe(false);
    expect(ran[0]).toContain("git@github.com:owner/config.git");
    expect(environments[0]).toContain("-i /run/secrets/deploy_key");
    expect(environments[0]).toContain("StrictHostKeyChecking=yes");
  });

  it("clones the flake's branch and commits as the configured author", async () => {
    const operation = update_operation(flake({ ...github, url: "github:owner/config/dev", commit_author: "Bot <bot@example.com>", commit_message: "build: bump inputs" }));
    const { context, ran } = fake_context((argv) => (argv.includes("update")
      ? { stderr: "• Updated input 'nixpkgs':\n" }
      : argv.includes("diff") ? { exit_code: 1 } : {}));

    expect(await github_update(context, operation as GithubUpdateOperation)).toBe(0);
    expect(ran[0]).toEqual(expect.arrayContaining(["--branch", "dev"]));
    const commit = ran.find((argv) => argv.includes("commit"))!;
    expect(commit).toEqual(expect.arrayContaining(["user.name=Bot", "user.email=bot@example.com"]));
    expect(commit[commit.indexOf("-m") + 1]).toBe("build: bump inputs\n\n- nixpkgs");
    expect(commit).not.toContain("commit.gpgsign=true");
    expect(ran.some((argv) => argv.includes("push"))).toBe(true);
  });

  it("signs a github: flake's update commit with commit_signing_key, so pull mode with allowed signers can deploy it", async () => {
    const operation = update_operation(flake({ ...github, commit_signing_key: "/var/lib/x-nix/signing_key" })) as GithubUpdateOperation;
    const { context, ran } = fake_context((argv) => (argv.includes("diff") ? { exit_code: 1 } : {}));

    expect(operation.signing_key).toBe("/var/lib/x-nix/signing_key");
    expect(await github_update(context, operation)).toBe(0);
    const commit = ran.find((argv) => argv.includes("commit"))!;
    expect(commit).toEqual(expect.arrayContaining(["gpg.format=ssh", "user.signingkey=/var/lib/x-nix/signing_key", "commit.gpgsign=true"]));
    expect(commit.indexOf("commit.gpgsign=true")).toBeLessThan(commit.indexOf("commit"));
  });

  it("puts the update on the branch's new tip when the branch moved during the check but kept its lock", async () => {
    const operation = update_operation(flake({ ...github, commit_signing_key: "/var/lib/x-nix/signing_key" })) as GithubUpdateOperation;
    let pushes = 0;
    const { context, ran, output } = fake_context((argv) => {
      if (argv.includes("diff")) return { exit_code: 1 };
      if (argv.includes("push")) return { exit_code: ++pushes === 1 ? 1 : 0 };
      if (argv.includes("--abbrev-ref")) return { stdout: "main\n" };
      if (argv.some((word) => word.endsWith(":flake.lock"))) return { stdout: "aaa\naaa\n" };
      if (argv.includes("rev-parse")) return { stdout: "c0ffee\n" };
      return {};
    });

    expect(await github_update(context, operation)).toBe(0);
    expect(pushes).toBe(2);
    expect(ran).toContainEqual(expect.arrayContaining(["fetch", "--depth", "1", "origin", "main"]));
    expect(ran).toContainEqual(expect.arrayContaining(["reset", "--quiet", "--hard", "FETCH_HEAD"]));
    expect(ran).toContainEqual(expect.arrayContaining(["checkout", "c0ffee", "--", "flake.lock"]));
    const commits = ran.filter((argv) => argv.includes("commit"));
    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual(expect.arrayContaining(["commit.gpgsign=true"]));
    expect(output()).toContain("main moved during the update");
  });

  it("leaves the update to the next run when the branch changed its own lock during the check", async () => {
    const operation = update_operation(flake(github)) as GithubUpdateOperation;
    const { context, ran, output } = fake_context((argv) => {
      if (argv.includes("diff") || argv.includes("push")) return { exit_code: 1 };
      if (argv.includes("--abbrev-ref")) return { stdout: "main\n" };
      if (argv.some((word) => word.endsWith(":flake.lock"))) return { stdout: "aaa\nbbb\n" };
      return {};
    });

    expect(await github_update(context, operation)).toBe(1);
    expect(ran.filter((argv) => argv.includes("push"))).toHaveLength(1);
    expect(ran.some((argv) => argv.includes("reset"))).toBe(false);
    expect(output()).toContain("changed its lock during the update");
  });

  it("gives up after three refused pushes", async () => {
    const operation = update_operation(flake(github)) as GithubUpdateOperation;
    const { context, ran } = fake_context((argv) => {
      if (argv.includes("diff") || argv.includes("push")) return { exit_code: 1 };
      if (argv.some((word) => word.endsWith(":flake.lock"))) return { stdout: "aaa\naaa\n" };
      return {};
    });

    expect(await github_update(context, operation)).toBe(1);
    expect(ran.filter((argv) => argv.includes("push"))).toHaveLength(3);
  });

  describe("landed as a pull request", () => {
    const folder = mkdtempSync(join(tmpdir(), "x-nix-tokens-"));
    const token_file = join(folder, "nix-access-tokens.conf");
    writeFileSync(token_file, "# tokens\nextra-access-tokens = gitlab.com=not-this-one github.com=test-token\n");
    const as_pull_request = { ...github, land_update: "pull_request", access_tokens_file: token_file };

    // A fetch answering GitHub's list of open pull requests and each change with what the test says, keeping every request.
    function fake_github(open: unknown[], change: { status: number; body: unknown } = { status: 201, body: { html_url: "https://github.com/owner/config/pull/8" } }) {
      const requests: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
      const fetcher = (async (url: string, init: RequestInit) => {
        requests.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
        const answer = init.method === "GET" ? { status: 200, body: open } : change;
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      }) as typeof fetch;
      return { fetcher, requests };
    }

    const changed_lock = (argv: string[]) => {
      if (argv.includes("rev-parse")) return { stdout: "main\n" };
      if (argv.includes("update")) return { stderr: "• Updated input 'nixpkgs':\n" };
      return argv.includes("diff") ? { exit_code: 1 } : {};
    };

    it("is asked for per flake, which needs a github: flake and an access_tokens_file", () => {
      const operation = inner_config(update_operation(flake(as_pull_request))) as GithubUpdateOperation;

      expect(operation.pull_request).toEqual({ repository: "owner/config", head: "x-nix/flake-update", token_file });
      expect((inner_config(update_operation(flake({ ...github, access_tokens_file: token_file }))) as GithubUpdateOperation).pull_request).toBeNull();
      expect(() => flake({ ...github, land_update: "pull_request" })).toThrow(/access_tokens_file/);
      expect(() => flake({ land_update: "pull_request", access_tokens_file: token_file })).toThrow(/github: flake/);
      expect(() => flake({ ...github, land_update: "sometimes" })).toThrow(ConfigError);
    });

    it("pushes the commit to its own branch and opens a pull request to the flake's branch", async () => {
      const operation = inner_config(update_operation(flake(as_pull_request))) as GithubUpdateOperation;
      const { context, ran, output } = fake_context(changed_lock);
      const github_api = fake_github([]);

      expect(await github_update(context, operation, github_api.fetcher)).toBe(0);

      expect(ran.filter((argv) => argv.includes("push"))).toEqual([["git", "-C", expect.any(String), "push", "--force", "origin", "HEAD:refs/heads/x-nix/flake-update"]]);
      const [listed, opened] = github_api.requests;
      expect(listed.url).toBe("https://api.github.com/repos/owner/config/pulls?state=open&head=owner%3Ax-nix%2Fflake-update&base=main");
      expect(listed.headers.authorization).toBe("Bearer test-token");
      expect(opened).toMatchObject({ method: "POST", body: { title: "chore(flake): update inputs", body: "- nixpkgs", head: "x-nix/flake-update", base: "main" } });
      expect(output().trim().split("\n").at(-1)).toBe("Opened pull request https://github.com/owner/config/pull/8");
      expect(output()).not.toContain("test-token");
    });

    it("brings the pull request already open up to date instead of opening another", async () => {
      const operation = inner_config(update_operation(flake(as_pull_request))) as GithubUpdateOperation;
      const { context, output } = fake_context(changed_lock);
      const github_api = fake_github([{ number: 7, html_url: "https://github.com/owner/config/pull/7" }], { status: 200, body: {} });

      expect(await github_update(context, operation, github_api.fetcher)).toBe(0);

      expect(github_api.requests.map((request) => `${request.method} ${request.url.replace(/\?.*/, "")}`)).toEqual([
        "GET https://api.github.com/repos/owner/config/pulls", "PATCH https://api.github.com/repos/owner/config/pulls/7",
      ]);
      expect(output()).toContain("Updated pull request https://github.com/owner/config/pull/7");
    });

    it("fails with GitHub's answer when it refuses, and before pushing when the file holds no github.com token", async () => {
      const operation = inner_config(update_operation(flake(as_pull_request))) as GithubUpdateOperation;
      const refused = fake_context(changed_lock);
      expect(await github_update(refused.context, operation, fake_github([], { status: 403, body: { message: "Resource not accessible" } }).fetcher)).toBe(1);
      expect(refused.output()).toContain('GitHub refused to open the pull request: 403 {"message":"Resource not accessible"}');

      const empty = join(folder, "empty.conf");
      writeFileSync(empty, "access-tokens = gitlab.com=not-this-one\n");
      const tokenless = fake_context(changed_lock);
      expect(await github_update(tokenless.context, { ...operation, pull_request: { ...operation.pull_request!, token_file: empty } }, fake_github([]).fetcher)).toBe(1);
      expect(tokenless.ran.some((argv) => argv.includes("push"))).toBe(false);
      expect(tokenless.output()).toContain(`${empty} holds no github.com access token`);
    });
  });

  it.each([{ status: 0, expected: 0 }, { status: 3, expected: 1 }])("prints its log once and keeps its status (nix exits $status)", async ({ status, expected }) => {
    // A clone succeeds, and diff says the lock is unchanged.
    const { context, output } = fake_context((argv) => (argv.includes("update") ? { exit_code: status, stderr: "Updated input 'nixpkgs'\n" } : {}));

    expect(await github_update(context, update_operation(flake(github)) as GithubUpdateOperation)).toBe(expected);
    expect(output().split("Updated input 'nixpkgs'").length - 1).toBe(1);
    expect(output().includes("Every input is already current")).toBe(status === 0);
  });
});

// ── Flake metadata ───────────────────────────────────────────────────────────

describe("an access_tokens_file", () => {
  const file = "/var/lib/x-nix/nix-access-tokens.conf";
  const tokens = { access_tokens_file: file };

  it("is handed to nix by path for the read and the update, sudo keeping NIX_CONFIG", () => {
    const update = update_operation(flake(tokens));

    expect(metadata_operation(flake(tokens))).toMatchObject({ kind: "nix_config", file, operation: { kind: "programs" } });
    expect(update).toMatchObject({ kind: "nix_config", file });
    expect((inner_config(update) as { steps: { argv: string[] }[] }).steps[0].argv.slice(0, 3)).toEqual(["sudo", "-n", "--preserve-env=NIX_CONFIG"]);
    expect(inner_config(update_operation(flake({ ...tokens, url: "github:owner/config", push_ssh_key: "/k" }))).kind).toBe("github_update");
    expect(metadata_operation(flake()).kind).toBe("programs");
  });

  it("is included through NIX_CONFIG after what the agent already sets", async () => {
    const environments: (string | undefined)[] = [];
    const { context } = fake_context((_argv, options) => {
      environments.push(options.env?.NIX_CONFIG);
      return {};
    });

    await perform(context, metadata_operation(flake(tokens)));

    expect(environments[0]?.endsWith(`include ${file}`)).toBe(true);
  });
});

// The operation inside a nix_config wrapper.
function inner_config(operation: Operation): Operation {
  return operation.kind === "nix_config" ? operation.operation : operation;
}

describe("the flake's metadata read", () => {
  it("fetches a remote flake afresh, and reads a local one from disk", () => {
    const argv = (values: Record<string, unknown>) => (metadata_operation(flake(values)) as { steps: { argv: string[] }[] }).steps[0].argv;

    expect(argv({ url: "github:owner/config" })).toEqual([...nix, "flake", "metadata", "--json", "--no-write-lock-file", "--refresh", "github:owner/config"]);
    expect(argv({})).not.toContain("--refresh");
  });
});

// ── Flakes in the config ─────────────────────────────────────────────────────

describe("a flake in the config", () => {
  it("is named by id from deployments and caches, which take its reference", () => {
    const config = parse_config({
      flakes: [{ id: "fleet", url: "github:owner/config" }],
      deployments: [{ id: "odin", host: "odin", flake: "fleet", pin: "v1" }, { id: "own", flake: "github:owner/own" }],
      caches: [{ id: "cache", flake: "fleet", configurations: ["odin"], cache_url: "https://attic.example/fleet" }],
    });

    expect(config.deployments.map(({ flake, flake_id }) => [flake, flake_id])).toEqual([["github:owner/config", "fleet"], ["github:owner/own", null]]);
    expect([config.caches[0].flake, config.caches[0].flake_id]).toEqual(["github:owner/config", "fleet"]);
  });

  it("needs a url and an id no deployment or cache takes", () => {
    expect(() => flake_settings({ id: "fleet" })).toThrow(ConfigError);
    expect(() => parse_config({ flakes: [{ id: "odin", url: "/etc/nixos" }], deployments: [{ id: "odin" }] })).toThrow(/Two flakes, deployments or caches/);
  });

  it("checks every input each minute unless told otherwise", () => {
    expect(flake()).toMatchObject({ input_check_interval: 60, watch_inputs: null, access_tokens_file: null });
    expect(flake({ input_check_interval: null, watch_inputs: ["nixpkgs"] })).toMatchObject({ input_check_interval: null, watch_inputs: ["nixpkgs"] });
  });

  it.each(["update_at", "push_ssh_key", "commit_author", "commit_message", "max_input_age"])("takes %s, which a deployment refuses", (key) => {
    expect(() => deployment_settings({ id: "odin", [key]: key === "update_at" ? "02:00" : "7d" })).toThrow(/belongs to its flake/);
  });
});

// ── Hosts in the config ──────────────────────────────────────────────────────

describe("a host in the config", () => {
  it.each(["gc", "boot", "require_sudo", "inhibit_sleep"])("takes %s, which a deployment refuses", (key) => {
    expect(() => deployment_settings({ id: "odin", [key]: false })).toThrow(/belongs to its host/);
  });

  it("gives its deployments its sudo and keep_awake, and is made for any host a deployment names", () => {
    const config = parse_config({ hosts: [{ id: "thor", require_sudo: false, wake_on_lan: "aa:bb:cc:dd:ee:ff" }], deployments: [{ id: "thor", host: "thor" }, { id: "own" }] }, "heimdall");

    expect(config.deployments.map(({ require_sudo, inhibit_sleep }) => [require_sudo, inhibit_sleep])).toEqual([[false, true], [true, false]]);
    expect(config.hosts.map((host) => host.id)).toEqual(["thor", "heimdall"]);
  });

  it("runs one deployment, counting a deployment that names no host as the server's own", () => {
    expect(() => parse_config({ deployments: [{ id: "odin", host: "thor" }, { id: "loki", host: "thor" }] })).toThrow(/both run on host 'thor'/);
    expect(() => parse_config({ deployments: [{ id: "odin", host: "heimdall" }, { id: "own" }] }, "heimdall")).toThrow(/both run on host 'heimdall'/);
  });
});

// ── Caches in the config ─────────────────────────────────────────────────────

describe("a cache a deployment names", () => {
  const cache = { id: "fleet", flake: "/etc/nixos", configurations: ["odin"], cache_url: "https://attic.example/fleet" };

  it("gives the deployment its URL, and takes over its own build settings", () => {
    const config = parse_config({ caches: [cache], deployments: [{ id: "odin", cache: "fleet", switch_from_cache: true }] });
    expect(config.deployments[0]).toMatchObject({ cache_id: "fleet", cache_url: "https://attic.example/fleet" });
    expect(() => parse_config({ caches: [cache], deployments: [{ id: "odin", cache: "fleet", build_at: "04:00" }] })).toThrow(/belongs to its cache/);
    expect(() => parse_config({ deployments: [{ id: "odin", cache: "fleet" }] })).toThrow(/names no cache/);
  });
});

// ── Flake references ─────────────────────────────────────────────────────────

describe("flake references", () => {
  it.each([
    ["/etc/nixos", "/etc/nixos"],
    ["path:/etc/nixos", "/etc/nixos"],
    ["git+file:///etc/nixos", "/etc/nixos"],
    ["git+file:///etc/nixos?ref=main", "/etc/nixos"],
    ["./config", "./config"],
    ["github:owner/config", null],
    ["gitlab:owner/config", null],
  ])("reads %s as the local path %s", (reference, expected) => {
    expect(local_path(reference)).toBe(expected);
  });

  it.each([
    ["github:owner/config", { name: "owner/config", ssh_url: "git@github.com:owner/config.git", branch: null }],
    ["github:owner/config/dev", { name: "owner/config", ssh_url: "git@github.com:owner/config.git", branch: "dev" }],
    ["github:owner/config?ref=dev", { name: "owner/config", ssh_url: "git@github.com:owner/config.git", branch: "dev" }],
    ["github:owner", null],
    ["/etc/nixos", null],
  ])("reads %s as a GitHub repository", (reference, expected) => {
    expect(github_repository(reference)).toEqual(expected);
  });

  it("shortens a revision, keeping the dirty mark", () => {
    expect(short_revision("a".repeat(40))).toBe("a".repeat(12));
    expect(short_revision(`${"a".repeat(40)}-dirty`)).toBe(`${"a".repeat(12)}-dirty`);
    expect(short_revision(null)).toBe("—");
  });
});

// ── Probe ────────────────────────────────────────────────────────────────────

describe("the probe", () => {
  it("reads the generation from the profile link", () => {
    expect(generation_of("system-210-link")).toBe(210);
    expect(generation_of("/nix/var/nix/profiles/system-7-link")).toBe(7);
    expect(generation_of("something-else")).toBeNull();
  });

  it("reads the facts the agent printed, and nothing from a probe that printed none", () => {
    expect(parse_probe('{"current":"/x","version":"26.11"}')?.version).toBe("26.11");
    expect(parse_probe("")).toBeNull();
  });

  it("cannot tell about a reboot without the booted parts", () => {
    expect(reboot_required([], [])).toBeNull();
    expect(reboot_required(["", ""], ["/a", "/b"])).toBeNull();
    expect(reboot_required(["/a"], ["/a"])).toBe(false);
    expect(reboot_required(["/a"], ["/b"])).toBe(true);
  });
});
