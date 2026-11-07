{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}:

buildNpmPackage {
  pname = "x-nix-agent";
  version = (lib.importJSON ../package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../src/agent
      ../src/shared
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = import ./npm-deps-hash.nix;

  nativeBuildInputs = [ makeWrapper ];

  # The agent runs its .ts files as they are, so there is nothing to build.
  dontNpmBuild = true;

  # Node will not run .ts files from under a node_modules folder, so the agent lives in lib/x-nix-agent.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save

    mkdir -p $out/lib/x-nix-agent/src
    cp -r package.json node_modules $out/lib/x-nix-agent/
    cp -r src/agent src/shared $out/lib/x-nix-agent/src/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/x-nix-agent \
      --add-flags $out/lib/x-nix-agent/src/agent/main.ts

    runHook postInstall
  '';

  meta = {
    description = "The X-Nix agent, which reads, builds and switches a NixOS host for the X-Nix server";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-nix-agent";
  };
}
