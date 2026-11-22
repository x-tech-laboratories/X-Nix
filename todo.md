# X-Nix

## Tasks

- [ ] Run each long run as its own transient systemd unit (`systemd-run --unit=x-nix-run-<id> --slice=<configured slice> --collect`), so stopping a run stops everything it started, through `systemctl stop`, instead of signalling one process group. Today a stop or a `systemctl stop x-nix-agent` leaves the run's `nix` processes running, and a stopped build's compilers stay under `nix-daemon.service`. On Odin on 2026-11-21 they kept every CPU busy until they were killed by hand. Needs an X-Libs `LongRuns` launcher option that tracks a run by unit name rather than pid, plus a sudo or polkit rule for the agent's user. With runs in their own units, the agent's `KillMode = "process"` can go back to the default, because a switch no longer has to outlive the agent's cgroup.
