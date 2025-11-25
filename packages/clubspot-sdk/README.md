# clubspot-sdk

[Clubspot](https://theclubspot.com/) is a SaaS product for managing Golf and Sailing clubs. It uses [Parse](https://parseplatform.org/)
application framework. This package is a community-supported, TypeScript SDK for Clubspot, utilizing the Parse
JavaScript SDK.

It exposes two utilities for interacting with Clubspot: a library of types to interact with the Clubspot backend, and a
simple program that that exposes that library as a CLI.

## Example Command Line Usage

```sh
# Install the package globally
pnpm install -g @cyc-seattle/clubspot-sdk

clubspot --help

# Print clubs that you admin
clubspot --username you@example.com --password hunter2 whoami
```

## Example Library Usage

```sh
pnpm install @cyc-seattle/clubspot-sdk
```

```typescript
import { Clubspot, Club } from "@cyc-seattle/clubspot-sdk";
import { Parse } from "parse/node.js";

const clubspot = new Clubspot();
clubspot.initialize(username, password);

const results = await Parse.Query(UserCLub).include("clubObject").equalTo("userObject", clubspot.user).limit(10).find();

console.log("Clubs that I admin:");
console.table(results.map((result) => result.get("clubObject.name")));
```
