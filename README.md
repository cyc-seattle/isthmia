# isthmia
[![APLv2][license-badge]][license]
[![Build Status - GitHub Actions][gha-badge]][gha-ci]

A collection of Typescript packages for managing CYC Community Sailing Center.

## Why this name?

[Wikipedia](https://en.wikipedia.org/wiki/Temple_of_Isthmia): "The Temple of Isthmia is an ancient Greek temple on the Isthmus of **Corinth** dedicated to the god **Poseidon** and built in
the Archaic Period."

## Contributing

### Development Tools

When working on this project, I decided to try out mise for managing dev tools and environments.  I've tried not to tie the project to that tool, but I may have failed, sorry. In particular,

* Dev tools are configured in `.tool-verions` used by `asdf` and `mise`.
* Secrets are stored in `.env`, which is used by `dotenv`, `direnv` and `mise` (with the `MISE_ENV_FILE=.env` setting).

[license-badge]: https://img.shields.io/badge/license-APLv2-blue.svg
[license]: https://github.com/ungood/clubspot-sdk/blob/main/LICENSE
[gha-badge]: https://github.com/ungood/clubspot-sdk/actions/workflows/nodejs.yml/badge.svg
[gha-ci]: https://github.com/ungood/clubspot-sdk/actions/workflows/nodejs.yml
