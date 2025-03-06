This package contains a CLI tool that runs reports that extracts data from Clubspot and copies it to various Google
spreadsheets.

## Authorization

### Clubspot

Clubspot credentials are read from CLI arguments, which are also mapped to the following environment variables.

```
CLUBSPOT_EMAIL="your email"
CLUBSPOT_PASSWORD="your password"
```

### Google

This package uses [Application Default Credentials](google-adc) to authenticate to Google's APIs. Follow the instructions
on that page to setup your Google Credentials and ask the administrator to grant you access to impersonate the
Admin Script Runner service account, then you can use `gcloud` to create a credential file.

```sh
gcloud auth application-default login \
    --impersonate-service-account  admin-scripts-runner@cyc-admin-scripts.iam.gserviceaccount.com
```

## Running

The CLI tool runs reports based on a config spreadsheet, which lists all of the reports to run and the source and
destination parameters thereof.

For CYC Community Sailing Center, the dev config sheet is:

```
CONFIG_SPREADSHEET_ID="1E-ByM0N6NRA53GcTA0BH0IL6MO87VBrAjhaI423USRY"
```

[google-adc]: https://img.shields.io/badge/license-APLv2-blue.svg