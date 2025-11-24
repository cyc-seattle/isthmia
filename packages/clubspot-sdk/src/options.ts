import { Option } from "@commander-js/extra-typings";

export class ClubspotUsernameOption extends Option<
  "-u, --username <username>",
  undefined,
  undefined,
  undefined,
  true,
  undefined
> {
  constructor() {
    super("-u, --username <username>");
    this.env("CLUBSPOT_EMAIL");
  }
}

export class ClubspotPasswordOption extends Option<
  "-p, --password <password>",
  undefined,
  undefined,
  undefined,
  true,
  undefined
> {
  constructor() {
    super("-p, --password <password>");
    this.env("CLUBSPOT_PASSWORD");
  }
}
