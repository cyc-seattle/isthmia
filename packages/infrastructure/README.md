# Isthmia Infrastructure

This package uses [Pulumi](https://www.pulumi.com/) to deploy the packages in this repository to GCP.

## Authorization

You'll need to be able to authorize as a user that has deployment permissions to the `cyc-admin-scripts` GCP project.

```sh
gcloud auth application-default login
gcloud auth configure-docker us-west1-docker.pkg.dev
```

## Deploy

```sh
pulumi up
```