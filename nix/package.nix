{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}:

buildNpmPackage {
  pname = "x-nix";
  version = (lib.importJSON ../package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.server.json
      ../tsconfig.web.json
      ../vite.config.ts
      ../src
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = "sha256-EXzgiW/b+2bZZwYEcZEtu5g4LCPHBKhozLKU5KDnnBo=";

  nativeBuildInputs = [ makeWrapper ];

  # Node will not run .ts files from under a node_modules folder, so the app lives in lib/x-nix.
  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save

    mkdir -p $out/lib/x-nix/src
    cp -r package.json dist node_modules $out/lib/x-nix/
    cp -r src/server src/agent src/shared $out/lib/x-nix/src/

    makeWrapper ${lib.getExe nodejs_24} $out/bin/x-nix \
      --add-flags $out/lib/x-nix/src/server/main.ts \
      --set-default NODE_ENV production

    runHook postInstall
  '';

  meta = {
    description = "A web portal for managing NixOS deployments";
    license = lib.licenses.gpl3Plus;
    mainProgram = "x-nix";
  };
}
