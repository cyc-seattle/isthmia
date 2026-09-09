import { LoggedQuery } from "./parse.js";
import { Camp, Club, Contract, Payout, QboSyncEvent, Registration, SesEmailSuppression, Transaction } from "./types.js";

/**
 * Returns a query that is similar to that used on the Camps->Entries page of the Clubspot dashboard.
 *
 * Includes only confirmed registrations, but does NOT filter out archived (cancelled).
 */
export function queryCampEntries(camp: Camp): LoggedQuery<Registration> {
  return (
    new LoggedQuery(Registration)
      .equalTo("campObject", camp)
      .exists("confirmed_at")
      .include("classes")
      .include("sessions")
      // @ts-expect-error - The Parse Typescript SDK isn't quite good enough to validate nested includes.
      .include("sessionJoinObjects.campSessionObject")
      // @ts-expect-error - The Parse Typescript SDK isn't quite good enough to validate nested includes.
      .include("sessionJoinObjects.campClassObject")
      .include("participantsArray")
  );
}

/**
 * Returns a query similar to the Events->Signups page of the Clubspot dashboard: confirmed
 * registrations across all event types (camps, regattas, and social events) for a club.
 */
export function queryRegistrations(club: Club): LoggedQuery<Registration> {
  return new LoggedQuery(Registration)
    .equalTo("clubObject", club)
    .equalTo("archived", false)
    .containedIn("status", ["confirmed", "applied", "invited"])
    .include("campObject")
    .include("eventObject")
    .include("regattaObject")
    .include("billing_registration")
    .include("participantsArray")
    .addDescending("confirmed_at");
}

/**
 * Returns a query for e-signature contracts (waivers, membership agreements, etc.), similar to
 * the E-signatures->Contracts page of the Clubspot dashboard.
 */
export function queryContracts(club: Club): LoggedQuery<Contract> {
  return new LoggedQuery(Contract)
    .equalTo("clubObject", club)
    .notEqualTo("archived", true)
    .include("waiverObject")
    .include("campObject")
    .include("regattaObject")
    .include("registrationObject")
    .addDescending("createdAt");
}

/**
 * Returns a query for the email bounce/unsubscribe suppression list. Check this before syncing
 * anyone into another mailing system (Google Groups, Listmonk, etc.) so suppressed addresses
 * aren't re-added.
 */
export function querySuppressedEmails(club: Club): LoggedQuery<SesEmailSuppression> {
  return new LoggedQuery(SesEmailSuppression)
    .equalTo("clubObject", club)
    .notEqualTo("archived", true)
    .addDescending("createdAt");
}

/**
 * Returns a query for the general-ledger journal entries ("Journal entries" in the Clubspot
 * dashboard) for a club within a date range - the ground truth that gets synced to QuickBooks
 * Online. See also queryQboSyncEvents to check whether that sync actually ran.
 */
export function queryTransactions(club: Club, start: Date, end: Date): LoggedQuery<Transaction> {
  return new LoggedQuery(Transaction)
    .equalTo("clubObject", club)
    .notEqualTo("archived", true)
    .greaterThanOrEqualTo("event_timestamp", start)
    .lessThanOrEqualTo("event_timestamp", end)
    .include("chartsArray")
    .addDescending("event_timestamp");
}

/**
 * Returns a query for the QuickBooks Online nightly sync run history, useful for verifying the
 * accounting sync actually succeeded. See Reporting->Accounting sync.
 */
export function queryQboSyncEvents(club: Club): LoggedQuery<QboSyncEvent> {
  return new LoggedQuery(QboSyncEvent)
    .equalTo("clubObject", club)
    .notEqualTo("archived", true)
    .notEqualTo("hidden", true)
    .addDescending("succeeded_at");
}

/**
 * Returns a query for Stripe payouts to the club's bank account, for reconciling Clubspot revenue
 * against bank deposits. See Reporting->Payouts.
 */
export function queryPayouts(club: Club): LoggedQuery<Payout> {
  return new LoggedQuery(Payout).equalTo("clubObject", club).notEqualTo("archived", true).addDescending("arrivalDate");
}
