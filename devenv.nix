{ pkgs, ... }:

{
  # Package dependencies
  packages = with pkgs; [
    just
    nodejs_22
    corepack_22
    pulumi
    google-cloud-sdk
  ];

  # Language-specific configurations
  languages = {
    javascript = {
      enable = true;
      package = pkgs.nodejs_22;
      corepack.enable = true;
    };
  };

  git-hooks.hooks = {
    treefmt.enable = true;
    eslint.enable = true;
  };

  # Treefmt configuration
  treefmt = {
    enable = true;
    config.programs = {
      nixfmt.enable = true;
      prettier = {
        enable = true;
        settings.editorconfig = true;
      };
    };
  };

  # Environment variables
  env = {
    CLOUDSDK_ACTIVE_CONFIG_NAME = "isthmia";
  };

  # Shell initialization
  enterShell = ''
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
    echo "Run 'just' to see available build commands"
    echo ""
  '';
}
