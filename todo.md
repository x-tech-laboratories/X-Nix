# X-Nix

## Tasks

- Try wake-on-LAN on the real phone: once Heimdall and Thor run the X-Nix from ed3b599 or later, start a Build or Update on Thor's page while it sleeps, and check the job shows "Waking thor", starts once its agent connects, and that Thor does not suspend until the job ends.
- Move the lenient JSON parser from X-Nix to X-Libs: routes would have to handle a `BAD_JSON` result first.
- Make the System page's pin field adopt the X-Libs input once `CommitInput` can save on blur without a button.
- Revisit the closure tree on `Tree` if it gains lazy children; it is still nested `<details>`.
- Port more generic UI to X-Libs: `EventsList`, a state-to-tone badge, and a jobs table/page.
- Fix the timing-flaky test in `tests/agents.test.ts`: it fails under parallel load and passes alone.
