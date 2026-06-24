{
  description = "pi-cc-commands: browse Claude Code-format slash commands inside pi without polluting context";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system};
      in {
        packages.default = pkgs.runCommandLocal "pi-cc-commands" { } ''
                         mkdir -p $out
                         cp -r ${self}/. $out/
                         '';
      });
}
