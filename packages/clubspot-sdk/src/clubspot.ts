import Parse from "parse/node.js";
import winston from "winston";

export class Clubspot {
  private _user!: Parse.User;
  public get user() {
    return this._user;
  }

  /**
   * Initializes the Parse SDK to the main Clubspot API and logins with the
   * supplied email address and password.
   */
  public async initialize(email: string, password: string) {
    const serverUrl = "https://theclubspot.com/parse";
    const applicationId = "myclubspot2017";

    Parse.CoreManager.set("SERVER_URL", serverUrl);
    Parse.initialize(applicationId);
    winston.debug("Parse initialized", { serverUrl, applicationId });

    const users = await this.retrieveUsersByEmail(email);

    if (users.length < 1) {
      throw new Error(`No user found with email address: ${email}`);
    }

    const user = users[0] as Parse.User;
    const username = user.getUsername();
    winston.debug("Logging into Clubspot", { email, username });

    // If this is not enabled, the current user is NOT stored in memory, and all future calls to parse are unauthenticated.
    // TODO: This would be more secure with a wrapper around Parse
    winston.warn("Enabling unsafe current user on Parse-SDK-JS");
    Parse.User.enableUnsafeCurrentUser();
    this._user = await Parse.User.logIn(username!, password);
  }

  /**
   * Retrieves a list of users registered with the given email address.
   * TODO: Add mobile phone lookup?
   */
  public retrieveUsersByEmail(email: string): Promise<Parse.User[]> {
    return Parse.Cloud.run("retrieveUsersByEmailOrMobileNumber", {
      email: email,
    });
  }
}
