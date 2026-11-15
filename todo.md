# X-Nix

## Tasks

- Try wake-on-LAN on the real phone: once Heimdall and Thor run the X-Nix from ed3b599 or later, start a Build or Update on Thor's page while it sleeps, and check the job shows "Waking thor", starts once its agent connects, and that Thor does not suspend until the job ends.
- Move the lenient JSON parser from X-Nix to X-Libs: routes would have to handle a `BAD_JSON` result first.
- Make the System page's pin field adopt the X-Libs input once `CommitInput` can save on blur without a button.
- Revisit the closure tree on `Tree` if it gains lazy children; it is still nested `<details>`.
- Port more generic UI to X-Libs: `EventsList`, a state-to-tone badge, and a jobs table/page.
- Fix the timing-flaky test in `tests/agents.test.ts`: it fails under parallel load and passes alone.
- Decide whether a switch whose `switch-to-configuration` exits 4 (it activated, but some units failed) should still roll back: `switch_system` treats every non-zero status as a failure, and one failed unit made Odin build and revert generations 505 to 513.
- Serve `/api/openapi.json`, which the Application Standard asks of every app: the `routes` table in `src/server/mcp.ts` already lists each call with its parameters, so it can be built from `api_spec`.
- Check a flake update before it is committed and pushed: evaluate, and optionally build, every deployment and cache naming the flake against the new lock, and keep the old lock if any fails. Today an update is pushed first and evaluated after, so a broken input reaches the remote.
- Offer to land a flake update as a pull request instead of pushing to its branch, so the change can be reviewed and pass CI first.
- Let a staged rollout wait between stages: a soak time after each stage, health checks passing over that time, and an optional admin approval before the next stage starts. Today it only stops on a failure, drift or `sync_timeout`.
- Record who started each job and fleet run (user or token, or the schedule, input check or webhook), and show it on the job and in the events, so every change has an audit trail.
- Defer a switch to the next boot when it changes what cannot be swapped live (the kernel, systemd, dbus or the init system): set the generation for boot instead, and show the host as waiting on a reboot.
