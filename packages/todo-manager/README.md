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

## TODO

* Add ability to assign tasks to people automatically (Jack)
