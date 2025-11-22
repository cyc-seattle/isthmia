This directory contains scripts and configuration for using [GAM](https://github.com/GAM-team/GAM) to manage CYC
Community Sailing Center's Google Workspace account.

## Todo

- Sync google groups members from participants
- Update / audit group settings from templates
- Sync google group managers from spreadsheet

## Environment Variables

The scripts in this directory utilize some common configuration in the form of environment variables:

```
GAM_PATH="<location to GAM command>"
GAM_ADMIN_USER="<the user that GAM is operating under>"
GAM_SPREADSHEET_ID="<ID of the spreadsheet to read batch commands from>"
```

## Templates

The JSON files in the `templates` directory contain common settings to apply to different types of groups:

- `participants.json`: Settings to apply to a group that contains participants in a program. All members should be able
  to post to the group, but otherwise it should be restricted.
