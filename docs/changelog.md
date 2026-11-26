---
title: Changelog
sidebar:
  order: 4
---

Every change to X-Nix, one line per commit, newest first. Work still to do is in the [roadmap](/roadmap/).
Each commit adds its own line under **Unreleased**, beneath the day it was made; a release renames that heading to its
version.

## Unreleased

### 2026-11-26

- fix(jobs): have stopping a guarded switch after its activation roll it back through its watchdog
- fix(builds): read any structured log line nix did not write as plain text instead of failing the job
- fix(hosts): hold reboots and collections off while a deployment switches, and switches while a collection runs
- fix(store): cap a job's output, prune old history and bound pull reports
- fix(nixos): bound the agent output lines parsers run patterns on
- fix(fleet): match selectors with a glob matcher and cap their length and terms

### 2026-11-24

- docs(roadmap): note the flaky agent key test
- test(hosts): cover the agent runs routes' refusals and failures
- docs(changelog): note list, stop and remove the runs an agent holds
- feat(hosts): list, stop and remove the runs an agent holds
- docs(changelog): note wake a sleeping host on demand
- feat(hosts): wake a sleeping host on demand
- fix(fleet): end a Build still held for its host when stopping a run's jobs
- docs(changelog): note stop a fleet run's running jobs too
- feat(fleet): stop a fleet run's running jobs too
- docs(changelog): note stop a job still waking its host
- fix(jobs): stop a job still waking its host

### 2026-11-22

- test: raise the coverage floor to what the update push retry's tests reach
- fix(update): push a github: flake's update onto the branch's new tip when the branch moved during the check
- docs: drop the screenshot of the old Users page
- docs(changelog): note installing the screen-off command under a fixed name
- docs(wake): install the Phosh screen-off command under a fixed name the server can name
- feat(wake): turn a woken host's screen back off with screen_off, and hold off only sleep during a job
- docs: a roadmap and a changelog in place of todo.md
- build(deps): bump the x-tech group with 2 updates
- build(deps): bump the npm group with 9 updates
- build(deps): bump @x-tech-laboratories/halon

### 2026-11-21

- docs: add the sign-in limits to the changelog
- build(deps): use X-Libs 0.72.0
- feat(server)!: sign-in limits, required second factor for admins, security headers and webhook replay guard
- test: raise the coverage floor to what main's tests reach
- ci: keep @types/node on the Node 24 runtime's major
- docs(todo): the wake-on-LAN test on Thor passed
- feat(web): move Users and every user's tokens onto Settings through the X-Libs users_settings
- build(deps): use X-Libs 0.71.0
- build(deps): use X-Libs 0.71.0 for route_openapi_document
- feat(web): draw the closure tree on the X-Libs Tree, each path's references listed once opened
- feat(web): save a deployment's pin once its field is left, through the X-Libs CommitInput
- fix!: harden X-Nix after its security audit
- feat(overview): put the job charts above Needs attention
- ci: update all npm dependencies weekly and auto-merge patch and minor ones
- feat(overview): chart hosts, flakes, caches, jobs, sync, reboots and agents as donuts, with a 24-hour or 7-day job view above Running now
- fix(dev): proxy only /api/ paths so the page's own api.ts loads
- test(fleet): build each deployment of the parallel run on its own host
- feat(flakes): land a github: flake's update as a pull request
- fix(switch): keep a switch whose activation only failed some units
- feat(deployments): hold a Build while another system builds on its host
- build(deps): use X-Libs 0.70.0
- feat(api): serve /api/openapi.json from the routes table
- docs: note the parts taken from X-Libs and close their to-dos
- refactor(web): fold the sidebar's sections through the X-Libs Shell
- refactor(web): take EventsList, the badges and the jobs table and page from X-Libs
- fix(server): refuse a body that is not JSON before a route takes it for empty
- refactor(agent): take the stall notes from X-Libs' agent/stalls
- refactor(server): take the notification channels from X-Libs, adding mail
- refactor(agent): take whole_lines from X-Libs
- test(agents): wait on the long run and the refusal instead of fixed sleeps
- feat(web): show a flake's jobs and events above its locked inputs
- build(deps): bump the x-tech group across 1 directory with 2 updates
- ci: build the Nix package and auto-merge Dependabot's X-Libs and Halon bumps
- ci: exempt X-Libs and Halon from the Dependabot cooldown

### 2026-11-19

- build(deps): update X-Libs to 0.66 and Halon to 0.27
- ci: update X-Libs and Halon daily with Dependabot
- feat(jobs): stop a running job from the page and MCP

### 2026-11-18

- fix(cache): ask the cache for missing paths with nix-store
- docs(todo): hold manual and scheduled builds behind a running system build
- fix(switch): build one system at a time per build host

### 2026-11-15

- fix(deployments): take a cache check that ends while a job runs, so a fixed evaluation shows before the job ends
- fix(switch): say when the cache holds the system but the host cannot fetch all of it
- fix(nix): cache narinfo misses for 60 s on X-Nix hosts, so a switch sees a system pushed after an earlier miss
- feat(switch): set a switch for the next boot when it changes the kernel, systemd or dbus
- feat(fleet): soak each finished stage and wait for approval before the next
- feat: record who started each job and fleet run
- feat(flake): check a flake update before writing or pushing its lock
- docs: add fleet management gaps to the task list
- chore: ignore node_modules directories and symlinks
- fix(web): show the X-Nix icon beside the brand in the sidebar
- docs: drop the Overview sidebar labels and move to X-Libs 0.56.0 and Halon 0.24.0
- docs(todo): serve /api/openapi.json
- fix(map): find a cache's row for a host by its configuration
- build: use X-Libs 0.55 and Halon 0.23.1, and draw the docs' diagrams
- fix(system): show the NixOS release in its tile
- docs: add user and developer guides as a GitHub Pages site
- build(nix): refresh the npm deps hash

### 2026-11-14

- feat(switch): show the derivation tree for nixos-rebuild on build_host and target_host
- fix(build): read nix activity ids as written so large ones stay apart
- feat(build): show the derivation tree for cache builds and local switches
- build(nix): read npm packages from package-lock.json and drop the npm deps hash
- feat(overview): show needs attention beside the hosts donut
- test(web): test how flakes, caches and hosts become the map
- test: drop the map test, which the server's tsconfig cannot compile
- build: use X-Libs 0.50 and Halon 0.20 for the flow map
- feat(web): map which flakes build which caches and the hosts they deploy to on the Overview
- ci: refresh a stale Nix npm deps hash with X-Libs' workflow
- build(nix): refresh the npm deps hash for X-Libs 0.46.0
- docs(readme): add a Ko-fi button beside the Liberapay one
- docs(readme): add a Liberapay donate button
- build(deps): move to X-Libs 0.46.0

### 2026-11-13

- fix(jobs): count only builders that failed in a build's Failed tile
- feat(jobs): show a build's derivations as a live tree table with each one's status
- feat(switch): build every action where direct_on says, including the automatic switch, and push at the pin
- feat(cache): push again a target the cache still lacks paths of after a check
- feat(store): collect garbage each day at gc.collect_at in place of the timer
- fix(switch): build the system before a guarded nixos-rebuild's watchdog starts
- feat(switch): build direct actions where direct_on says, pushing through the cache to the host
- docs(todo): add deciding whether a switch that exits 4 rolls back
- feat(web): show close_nix_lock_holders among a deployment's switch safety
- feat(switch): run builds and switches from the API and fleet runs directly, never waiting on a cache
- feat(web): list every flake, cache and host under its section in the sidebar, as a tree that folds
- fix(switch): end a hung switch on its watchdog's outcome, and report and warn of stalled jobs

### 2026-11-12

- fix(mcp): keep installing onto a machine off MCP, since it wipes its disks
- feat(mcp): offer health, the caller, backups and installing as MCP tools
- feat(web): add a Settings page with the theme, the server, AI clients and backups
- feat(web): pin the theme, the account and Settings in the sidebar's foot

### 2026-11-11

- docs(agents): point agents at the X-Tech standards and X-Libs

### 2026-11-10

- feat(backups): back up the state database daily, with a Backups page for admins
- feat(mcp): offer the API to AI clients as MCP tools at /api/mcp (#7)
- chore: keep the icon's source at resources/icon.svg and generate the page's PNGs from it
- test(agents): wait for the long run to finish rather than a fixed second
- build(deps): take X-Libs 0.31.0 for the shared accounts
- feat(auth): sign in through the shared X-Libs accounts

### 2026-11-09

- docs(todo): note the open items from the X-Libs adoption
- build(deps): use x-libs 0.25.0
- refactor: take the forge webhook checks, Wake-on-LAN, the cycle poller and the run follower from X-Libs
- feat(flake): update as soon as a watched input moves upstream
- fix(poller): poll a cache soon after a deployment starts its build
- fix(nix): update the npm dependencies hash for X-Libs 0.22.0 and Halon 0.11.0

### 2026-11-08

- feat: chart the fleet, jobs, stores, builds, closures, caches, flakes and fleet runs
- feat: update open pages live and take sign-in, the API client and programs from X-Libs
- feat: run on X-Libs 0.20.0 and Halon 0.10.0
- ci: install Nix so the provisioning test can parse media expressions
- feat(web): order the sidebar overview, flakes, cache, hosts, jobs, provision
- fix(deps): take x-libs 0.11.1 to stop tables redrawing forever
- feat: run on X-Libs 0.11.0 and Halon 0.5.0 and release 0.3.0

### 2026-11-07

- feat: run on X-Libs 0.6.0 and release 0.2.0
- refactor(web): draw the page with React on X-Libs' React widgets

### 2026-11-06

- refactor(web): draw the page with Preact on the shared X-Libs widgets and Halon
- refactor: run the agents, keys, durations, passwords and logins on x-libs and Fastify's plugins

### 2026-11-03

- fix(switch): show the output of the build a switch waits on in the switch's job
- fix(web): fix three layout faults the screenshots showed
- fix(flake): refetch followed branches when updating a lock
- fix(web): space every panel's and stack's blocks, and put Details after Findings
- fix(web): space the Overview's tiles from Needs attention
- feat(switch): run the evaluation and build a switch depends on before it starts
- feat(web): show each fact in one place
- feat(web): merge the Deployments page into Hosts
- feat(config)!: allow one deployment per host
- feat(web): order the sidebar by fleet, sources, history and setup
- fix(cache): push a target from the host whose store its row was read from
- fix(flake): evaluate deployments when a read finds the flake changed
- feat(builds): rank a cache's hosts and a deployment's build agents by preference
- feat(web): fold the Store and Boot pages into each host's page
- feat(web): merge the Fleet page into Deployments
- fix(switch): fetch a switch from the cache before its watchdog starts
- refactor(agent)!: perform typed operations in TypeScript instead of shell scripts
- fix(caches): read a cache row saved without an evaluation error as having none
- feat(caches): evaluate each deployment a cache builds once, in the cache's check
- feat(caches)!: let a deployment name the cache that builds its system, and give caches a daily Build all
- feat(hosts)!: make hosts their own entity, holding the agent, waking, store and boot entries
- fix(cache): ask the cache afresh instead of trusting nix's remembered misses
- fix(switch): take the system the cache built when the flake moved past the evaluation
- feat(switch): build the missing system in the cache for an automatic switch too
- feat(auth): log in as separate users, each with their own password
- feat(web): show the X-Nix icon above the login form
- feat(switch): build the system in the cache first when a switch from the cache finds it missing
- feat(flakes)!: make flakes their own entity that deployments and caches name
- docs(todo): test wake-on-LAN on the real phone
- feat(agents): wake hosts through another agent and keep them awake during jobs
- fix(web): enlarge the icon's snowflake to match the other X-apps' glyphs
- fix(web): cut the official Nix snowflake out of the X-Tech hexagon for the icon
- fix(switch): fetch a switch from the cache through the host's substituters
- feat(web): add a hexagon icon with the Nix snowflake as the favicon
- feat(agents): start jobs on a sleeping host at once and run them once it wakes
- feat(agents): wake sleeping hosts with wake-on-LAN before operations

### 2026-11-01

- Validate recursive cache closures before switching
- feat(switch): wait for the cache to hold the new system before switching from it automatically
- feat(switch): guard switches from the cache, keep hosts awake and run post_switch as root
- feat(nix): ship the sudo rules X-Nix needs with both modules
- docs(install): rewrap the provisioning paragraph
- feat(install)!: show the generated hardware configuration without writing it to a path
- feat(secrets)!: remove secrets upload and the Secrets page
- feat(options)!: remove the Options page, its search and its options form
- feat(inventory)!: remove the Inventory page and the inventory setting
- fix(switch): remove the watchdog's folder once its outcome is read, and sweep stale ones

### 2026-10-31

- docs(todo): drop the tooling features now built
- feat(inventory): edit the fleet's machines, tags and roles in one file
- feat(options): search options and packages and commit simple options
- feat(secrets): upload keys to hosts outside the store
- fix(config): refuse switch_from_cache together with a guarded switch
- docs(switch): document switch modes, safety settings, the diff and rollbacks
- feat(web): confirm switches with their diff, browse closures and roll back
- test(switch): cover guarded switches, rollback, the diff and build progress
- feat(switch): guard switches with checks, health checks and a rollback watchdog
- docs(fleet): document fleet runs, pins, the push webhook and pull mode
- feat(web): fleet page, fleet status table and deployment pin form
- feat(fleet): fleet runs, staged rollouts, pins, push webhook and agent pull mode
- feat(builds): keep a browsable build history with downloadable products
- feat(cache): build every target in one parallel pass with Build all
- feat(cache): show the cache server's own health and size
- feat(deployment): switch from the cache without evaluating or building on the host
- docs(install): document provisioning and put nixos-anywhere on the PATH
- feat(install): add the Provision page
- feat(install): install new hosts with nixos-anywhere and build install media
- docs(todo): leave the general fleet-manager features to X-Monitor
- docs(todo): replace the tooling survey with the features it found
- docs(todo): drop the finished X-Monitor port and stack notes
- docs(todo): record X-Nix taking over the fleet's NixOS upkeep
- feat(agents): port X-Backups' agent so deployments and caches reach other hosts
- feat(boot): port X-Monitor's host_control boot entries as the Boot page, with Set next boot
- feat(cache): port X-Monitor's attic_push as caches with per-target Build and Push
- feat(store): port X-Monitor's nix_gc as each deployment's Store, with Collect Garbage
- feat: require a password login and add a NixOS module running X-Nix as services.x-nix
- feat(deployments): port X-Monitor's nixos_upgrade as deployments with drift, evaluation, jobs, auto-switch and daily slots
- feat: scaffold the web app with a Fastify server, a Vite page themed with Halon, and a Nix package
- docs: make the stack a TypeScript web app, not Electron
- docs: add todo with X-Monitor NixOS port and tooling survey
- chore: initial commit
