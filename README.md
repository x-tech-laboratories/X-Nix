# X-Nix

A web portal for managing NixOS deployments: drift against the flake, updates, builds, switches,
the Nix store, the Attic cache and boot entries.

## Development

```sh
nix develop           # or nix-shell
npm install
npm run dev:server    # the API on http://127.0.0.1:7720
npm run dev:web       # the page, reaching the API through Vite's proxy
```

`npm run build` type-checks and builds the page into `dist/`; `npm start` serves both on one port.
`npm test` runs the tests and `npm run lint` the linter.

## Settings

| Variable            | Default       | Meaning                                  |
| ------------------- | ------------- | ---------------------------------------- |
| `HOST`              | `127.0.0.1`   | The address the server listens on.       |
| `PORT`              | `7720`        | The port the server listens on.          |
| `X_NIX_SERVER_NAME` | the hostname  | What the page calls the server's machine. |

## Package

`nix build` builds the `x-nix` program from the flake.

## License

GPL-3.0-or-later.
