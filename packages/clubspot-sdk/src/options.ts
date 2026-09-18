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
  "--password <password>",
  undefined,
  undefined,
  undefined,
  true,
  undefined
> {
  constructor() {
    super("--password <password>");
    this.env("CLUBSPOT_PASSWORD");
    // A secret on argv lands in `ps` output and shell history; CLUBSPOT_PASSWORD is the
    // supported input. Commander still needs a flags string to bind the env var to.
    this.hideHelp();
  }
}
