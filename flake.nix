{
  description = "Isthmia - CYC Seattle sailing registration system";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    treefmt-nix.url = "github:numtide/treefmt-nix";
    git-hooks-nix = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{
      self,
      flake-parts,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.treefmt-nix.flakeModule
        inputs.git-hooks-nix.flakeModule
      ];

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        {
          config,
          pkgs,
          ...
        }:
        {
          treefmt = {
            programs = {
              nixfmt.enable = true;
              prettier = {
                enable = true;
                settings.editorconfig = true;
              };
            };
            projectRootFile = "flake.nix";
          };

          pre-commit.settings.hooks = {
            treefmt.enable = true;
            eslint.enable = true;
          };

          devShells.default = pkgs.mkShell {
            inputsFrom = [ config.pre-commit.devShell ];
            packages = with pkgs; [
              just
              nodejs_22
              corepack_22
              pulumi
              google-cloud-sdk
            ];

            shellHook = ''
              # Add built CLI tools to PATH
              export PATH="$PWD/node_modules/.bin:$PATH"

              # Auto-install and build if node_modules doesn't exist
              if [ ! -d "node_modules" ]; then
                echo "Installing dependencies..."
                pnpm install
              fi

              echo ""
              echo "Available CLI tools:"
              echo "  calendar-sync  - Sync events between Google Calendar and Spreadsheet"
              echo "  todo-manager   - Sync tasks from Clubspot to Todoist"
              echo "  clubspot       - Clubspot SDK CLI"
              echo ""
              echo "Run 'just' to see available commands"
            '';
          };

          formatter = config.treefmt.build.wrapper;
        };
    };
}
