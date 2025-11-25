import { Camp, LoggedQuery, queryCampEntries, Registration, RegistrationCampSession } from "@cyc-seattle/clubspot-sdk";
import { Report } from "./reports.js";
import { HeaderValues } from "@cyc-seattle/gsuite";
import winston from "winston";

type ContactRow = {
  "Registration Id": string;
  "Participant Id": string;
  Participant: string;
  Type: "Participant" | "Primary" | "Secondary";
  Status: string;
  Name: string;
  Email: string;
  Camp: string;
  Class: string;
  Session: string;
  "Session Start": string;
};

export class ContactReport extends Report {
  static headers = [
    "Registration Id",
    "Participant Id",
    "Participant",
    "Type",
    "Status",
    "Name",
    "Email",
    "Camp",
    "Class",
    "Session",
    "Session Start",
  ] satisfies HeaderValues<ContactRow>;

  get campId() {
    return this.arguments;
  }

  private calculateStatus(registration: Registration, joinObject: RegistrationCampSession) {
    const archived = registration.get("archived") ?? false;
    const waitlist = joinObject.get("waitlist") ?? false;

    if (archived) {
      return "cancelled";
    }

    if (waitlist) {
      return "waitlist";
    }

    return registration.get("status");
  }

  public async run() {
    const table = await this.getOrCreateTable(ContactReport.headers);

    const camp = await new LoggedQuery(Camp).get(this.campId);
    winston.info("Reporting contacts for camp", camp);

    const registrationsQuery = queryCampEntries(camp).notEqualTo("archived", true).limit(1000);
    const registrations = await this.updatedBetween(registrationsQuery).find();

    /*
     * When sessions are removed/changed from a camp registration, the sessionJoinObject will no
     * longer have the removed session. Since we don't have the removed session ids any more, we can't
     * remove the old rows so we will have cancelled participants still in our list.
     *
     * This hacky solution is to find all existing rows with the same registration and participant ids
     * and to mark them as "cancelled".  This designation will get overwritten if a sessionJoinObject
     * DOES exist for those rows.
     */
    winston.info("Temporarily cancelling all existing records");
    for (const registration of registrations) {
      for (const participant of registration.get("participantsArray") ?? []) {
        table.updateRows(["Registration Id", "Participant Id"], {
          "Registration Id": registration.id,
          "Participant Id": participant.id,
          Status: "cancelled",
        });
      }
    }
    await table.save(true);

    for (const registration of registrations) {
      for (const joinObject of registration.get("sessionJoinObjects") ?? []) {
        const campSession = joinObject.get("campSessionObject");
        const campClass = joinObject.get("campClassObject");

        for (const participant of registration.get("participantsArray") ?? []) {
          const firstName = registration.get("firstName")?.trim();
          const lastName = registration.get("lastName")?.trim();
          const participantName = `${firstName} ${lastName}`;
          const campName = camp.get("name");
          const className = campClass.get("name");
          const sessionName = campSession.get("name");

          const contacts = [
            {
              type: "Participant",
              name: participantName,
              email: participant.get("email"),
            },
            {
              type: "Primary",
              name: participant.get("parentGuardianName"),
              email: participant.get("parentGuardianEmail"),
            },
            {
              type: "Secondary",
              name: participant.get("parentGuardianName_secondary"),
              email: participant.get("parentGuardianEmail_secondary"),
            },
          ];

          for (const contact of contacts) {
            if (contact.email !== undefined && contact.email.length > 0) {
              table.addOrUpdate(["Registration Id", "Participant Id", "Type"], {
                "Registration Id": registration.id,
                "Participant Id": participant.id,
                Participant: participantName,
                Type: contact.type,
                Status: this.calculateStatus(registration, joinObject),
                Name: contact.name,
                Email: contact.email,
                Camp: campName,
                Class: className,
                Session: sessionName,
                "Session Start": this.formatDate(campSession.get("startDate")),
              });
            }
          }
        }
      }
    }

    await table.save();
  }
}
