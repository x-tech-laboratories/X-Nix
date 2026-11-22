# X-Nix

## Tasks

- Try wake-on-LAN on the real phone: once Heimdall and Thor run the X-Nix from ed3b599 or later, start a Build or Update on Thor's page while it sleeps, and check the job shows "Waking thor", starts once its agent connects, and that Thor does not suspend until the job ends.
- Make the System page's pin field adopt the X-Libs input once `CommitInput` can save on blur without a button.
- Revisit the closure tree on `Tree` if it gains lazy children; it is still nested `<details>`.
- Serve `/api/openapi.json`, which the Application Standard asks of every app: the `routes` table in `src/server/mcp.ts` already lists each call with its parameters, so it can be built from `api_spec`.
- Offer to land a flake update as a pull request instead of pushing to its branch, so the change can be reviewed and pass CI first.
