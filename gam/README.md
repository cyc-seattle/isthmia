This directory contains scripts and configuration for using [GAM](https://github.com/GAM-team/GAM) to manage CYC
Community Sailing Center's Google Workspace account.

## Environment Variables

The scripts in this directory utilize environment variables for configuration, which are automatically set by devenv:

- `GAM_ADMIN_USER`: The user that GAM operates under (set in `devenv.nix`)
- `GAM_SPREADSHEET_ID`: ID of the spreadsheet to read batch commands from (set in `devenv.nix`)

## Authentication

GAM requires authentication to access Google Workspace. The first time you run GAM, you'll need to authenticate:

```bash
just auth
```

## Scripts

### apply-templates

Applies group settings from a template file for each group listed in the "Group Templates" worksheet of `GAM_SPREADSHEET_ID`.

**Usage:**

```bash
./scripts/apply-templates
```

**Spreadsheet columns:**

- `Email`: The group email address
- `Template`: Path to the template JSON file (relative to `templates/` directory)

### export-groups

Exports all Google Groups (name, description, and settings) to the "Groups Export" worksheet in `GAM_SPREADSHEET_ID`.

**Usage:**

```bash
./scripts/export-groups
```

### export-group-members

Exports all group members across all groups to the "Groups Members Export" worksheet in `GAM_SPREADSHEET_ID`.

**Usage:**

```bash
./scripts/export-group-members
```

### update-groups-from-contacts

Updates group members from a participants spreadsheet by filtering on camp name and class name. The script is currently configured for Spring 2025 race teams.

**Usage:**

```bash
./scripts/update-groups-from-contacts
```

**Note:** This script hardcodes a specific spreadsheet ID and camp/class filters. Edit the script to change the source spreadsheet or participant filters.

### update-groups-from-roles

Updates group members and managers based on role assignments from the "Role Mapping" worksheet in `GAM_SPREADSHEET_ID`. The script reads role assignments and adds users to the appropriate groups.

**Usage:**

```bash
./scripts/update-groups-from-roles
```

**Spreadsheet columns:**

- `Email`: User email address
- `Roles`: Comma-separated list of roles (e.g., "Parent Coordinator", "Group Manager")

## Templates

The JSON files in the `templates` directory contain group settings to apply to different types of groups. See the [GAM Cheat Sheet](https://gamcheatsheet.com/GAM%20Cheat%20Sheet%20A4.pdf) for more details on group settings.

### announcement.json

**Use case:** Announcement-only groups where only managers can post.

**Key settings:**

- Only managers and owners can post messages
- All members can view messages
- No collaborative inbox
- Messages are archived

### crew.json

**Use case:** Collaborative team groups where all members actively participate.

**Key settings:**

- Anyone can post messages (internal and external)
- Members can post as the group
- Members have permissions to manage topics, mark favorites, assist with content
- Messages are archived

### inbox.json

**Use case:** Shared inbox for team collaboration with inbox-style organization.

**Key settings:**

- Collaborative inbox enabled
- Anyone can post messages
- Members can moderate content, delete posts, manage topics
- Default sender is the group (not individual)
- Messages are archived

### participants.json

**Use case:** Program participant groups where members can communicate but management is restricted.

**Key settings:**

- All members can post messages
- Only managers can moderate, manage members, or perform administrative tasks
- Messages are archived
- Not shown in group directory

## Common Commands

See the [GAM Cheat Sheet](https://gamcheatsheet.com/GAM%20Cheat%20Sheet%20A4.pdf) for more commands.

### Managing Groups

Clear all members from a group (e.g., at the start of a season):

```bash
gam update group <group-email> clear member
```

### Working with Templates

Create a template based on an existing group:

```bash
gam info group "<group-email>" noaliases nousers formatjson > "<template-path>"
```

Apply a template to a group:

```bash
gam update group "<group-email>" json file "<template-path>"
```
