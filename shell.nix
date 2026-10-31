{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_24 # Runs the server's .ts files directly and builds the web page.
    git
  ];
}
