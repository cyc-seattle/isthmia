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

This package authenticates to Google's APIs with [Application Default Credentials][google-adc]. Run
`just auth-adc` from the repository root to point ADC at your own account.

The deployed job runs as `report-runner@cyc-admin-scripts.iam.gserviceaccount.com`, so a local run
can see a different set of spreadsheets than production does.

## Running

The CLI tool runs reports based on a config spreadsheet, which lists all of the reports to run and the source and
destination parameters thereof.

For CYC Community Sailing Center, the dev config sheet is:

```
CONFIG_SPREADSHEET_ID="1E-ByM0N6NRA53GcTA0BH0IL6MO87VBrAjhaI423USRY"
```

[google-adc]: https://cloud.google.com/docs/authentication/application-default-credentials
