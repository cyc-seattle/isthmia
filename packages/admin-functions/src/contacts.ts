import { Camp, LoggedQuery, queryCampEntries } from '@cyc-seattle/clubspot-sdk';
import { Report } from './reports.js';
import { HeaderValues } from './spreadsheets.js';
import winston from 'winston';

type ContactRow = {
  Participant: string;
  Type: 'Participant' | 'Guardian';
  Name: string;
  Email: string;
  Camp: string;
  Class: string;
  Session: string;
};

export class ContactReport extends Report {
  static headers = [
    'Participant',
    'Type',
    'Name',
    'Email',
    'Camp',
    'Class',
    'Session',
  ] satisfies HeaderValues<ContactRow>;

  get campId() {
    return this.arguments;
  }

  public async run() {
    const table = await this.getOrCreateTable(ContactReport.headers);

    const camp = await new LoggedQuery(Camp).get(this.campId);
    winston.info('Reporting contacts for camp', camp);

    const registrationsQuery = queryCampEntries(camp)
      .notEqualTo('archived', true)
      .limit(1000);
    const registrations = await this.updatedBetween(registrationsQuery).find();

    for (const registration of registrations) {
      for (const joinObject of registration.get('sessionJoinObjects') ?? []) {
        const campSession = joinObject.get('campSessionObject');
        const campClass = joinObject.get('campClassObject');

        for (const participant of registration.get('participantsArray') ?? []) {
          const firstName = registration.get('firstName')?.trim();
          const lastName = registration.get('lastName')?.trim();
          const participantName = `${firstName} ${lastName}`;
          const campName = camp.get('name');
          const className = campClass.get('name');
          const sessionName = campSession.get('name');

          const contacts = [
            {
              type: 'Participant',
              name: participantName,
              email: participant.get('email'),
            },
            {
              type: 'Guardian',
              name: participant.get('parentGuardianName'),
              email: participant.get('parentGuardianEmail'),
            },
            {
              type: 'Guardian',
              name: participant.get('parentGuardianName_secondary'),
              email: participant.get('parentGuardianEmail_secondary'),
            },
          ];

          for (const contact of contacts) {
            if (contact.email !== undefined && contact.email.length > 0) {
              table.addOrUpdate(ContactReport.headers, {
                Participant: participantName,
                Type: contact.type,
                Name: contact.name,
                Email: contact.email,
                Camp: campName,
                Class: className,
                Session: sessionName,
              });
            }
          }
        }
      }
    }

    await table.save();
  }
}
