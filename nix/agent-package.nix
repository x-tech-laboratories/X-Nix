{
  lib,
  stdenvNoCC,
  nodejs_24,
  makeWrapper,
}:

# The agent needs only Node's own modules, so it is just its sources and a wrapper.
stdenvNoCC.mkDerivation {
  pname = "x-nix-agent";
  version = (lib.importJSON ../package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../src/agent
      ../src/shared
    ];
  };

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/x-nix-agent/src
    cp package.json $out/lib/x-nix-agent/
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
