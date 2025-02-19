

## Authorization

### Clubspot

### Google

This package uses [Application Default Credentials](google-adc) to authenticate to Google's APIs. Follow the instructions
on that page to setup your Google Credentials and ask the administrator to grant you access to impersonate the
Admin Script Runner service account, then you can use `gcloud` to create a credential file.

```sh
gcloud auth application-default login \
    --impersonate-service-account  admin-scripts-runner@cyc-admin-scripts.iam.gserviceaccount.com
```

[google-adc]: https://img.shields.io/badge/license-APLv2-blue.svg