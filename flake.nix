{
  description = "Isthmia - CYC Community Sailing Center operations tools";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    git-hooks-nix = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      imports = [
        inputs.treefmt-nix.flakeModule
        inputs.git-hooks-nix.flakeModule
      ];

      perSystem =
        { pkgs, config, ... }:
        {
          # Treefmt configuration
          treefmt = {
            projectRootFile = "flake.nix";
            programs = {
              nixfmt.enable = true;
              prettier = {
                enable = true;
                settings.editorconfig = true;
              };
            };
          };

          # Git hooks configuration
          pre-commit.settings.hooks = {
            treefmt = {
              enable = true;
              package = config.treefmt.build.wrapper;
            };
            eslint.enable = true;
          };

          # Development shell
          devShells.default = pkgs.mkShell {
            inputsFrom = [ config.pre-commit.devShell ];

            packages = with pkgs; [
              just
              nodejs_22
              corepack_22
              gam
              pulumi
              pulumiPackages.pulumi-language-nodejs
              google-cloud-sdk
              config.treefmt.build.wrapper
            ];

            env = {
              CLOUDSDK_ACTIVE_CONFIG_NAME = "isthmia";
              GAM_ADMIN_USER = "master@cyccommunitysailing.org";
              GAM_PROJECT_ID = "gam-project-sby17";
              GAM_SERVICE_ACCOUNT_NAME = "gam-project-sby17";
              GAM_SPREADSHEET_ID = "1iSa8Ff07VizzaKnlpMWWnVx0GORi4pnAXhrH17JL8qE";
            };

            shellHook = ''
              # Add built CLI tools to PATH
              export PATH="$PWD/node_modules/.bin:$PATH"

              echo ""
              echo "Available CLI tools:"
              echo "  calendar-sync  - Sync events between Google Calendar and Spreadsheet"
              echo "  todo-manager   - Sync tasks from Clubspot to Todoist"
              echo "  clubspot       - Clubspot SDK CLI"
              echo ""
              echo "Run 'just' to see available build commands"
              echo ""
            '';
          };
        };
    };
}
