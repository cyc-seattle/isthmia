This package contains a CLI tool that creates todoist projects based on simple templates.

## Installation

```sh
# Install the package globally (alternately, link it)
pnpm install -g @cyc-seattle/todo-manager

todo-manager --help
```

## Authorization

Credentials are read from CLI arguments, which are also mapped to the following environment variables.  You can
get your API token from: https://app.todoist.com/app/settings/integrations/developer

```
TODOIST_API_TOKEN="your token"
CLUBSPOT_USERNAME="your clubspot username"
CLUBSPOT_PASSWORD="your clubspot password"
```

## Running

The CLI tool runs reports based on a config spreadsheet, which lists all of the reports to run and the source and
destination parameters thereof.

For CYC Community Sailing Center, the dev config sheet is:

```
CONFIG_SPREADSHEET_ID="1E-ByM0N6NRA53GcTA0BH0IL6MO87VBrAjhaI423USRY"
```

[google-adc]: https://img.shields.io/badge/license-APLv2-blue.svg