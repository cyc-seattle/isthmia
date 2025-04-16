import {
  Camp,
  queryCampEntries,
  LoggedQuery,
  Registration,
  RegistrationCampSession,
} from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report } from './reports.js';
import { HeaderValues } from './spreadsheets.js';

type ParticipantsRow = {
  readonly 'Registration Id': string;
  readonly 'Participant Id': string;
  readonly 'Session Join Id': string;
  readonly 'First Name': string | undefined;
  readonly 'Last Name': string | undefined;

  readonly Camp: string;
  readonly Class: string;
  readonly Session: string;
  readonly 'Session Start': string;
  readonly Status: string | undefined;
  readonly 'Registration Date': string;

  readonly 'Date of Birth': string | undefined;
  readonly Gender: string | undefined;
  readonly Email: string | undefined;
  readonly Mobile: string | undefined;
  readonly 'Postal Code': string | undefined;

  readonly 'First Guardian': string | undefined;
  readonly 'First Guardian Email': string | undefined;
  readonly 'First Guardian Mobile': string | undefined;

  readonly 'Second Guardian': string | undefined;
  readonly 'Second Guardian Email': string | undefined;
  readonly 'Second Guardian Mobile': string | undefined;

  readonly 'Emergency Contact': string | undefined;
  readonly 'Emergency Contact Mobile': string | undefined;

  readonly 'Medical Details': string | undefined;
  readonly Allergies: string | undefined;
  readonly Medication: string | undefined;
  readonly 'Last Tetanus Shot': string | undefined;
};

export class ParticipantsReport extends Report {
  static headers = [
    'Registration Id',
    'Participant Id',
    'Session Join Id',
    'First Name',
    'Last Name',

    'Camp',
    'Class',
    'Session',
    'Session Start',
    'Status',
    'Registration Date',

    'Date of Birth',
    'Gender',
    'Email',
    'Mobile',
    'Postal Code',

    'First Guardian',
    'First Guardian Email',
    'First Guardian Mobile',

    'Second Guardian',
    'Second Guardian Email',
    'Second Guardian Mobile',

    'Emergency Contact',
    'Emergency Contact Mobile',

    'Medical Details',
    'Allergies',
    'Medication',
    'Last Tetanus Shot',

    // TODO: Custom Fields, Weight, School
  ] satisfies HeaderValues<ParticipantsRow>;

  get campId() {
    return this.arguments;
  }

  private calculateStatus(
    registration: Registration,
    joinObject: RegistrationCampSession,
  ) {
    const archived = registration.get('archived') ?? false;
    const waitlist = joinObject.get('waitlist') ?? false;

    if (archived) {
      return 'cancelled';
    }

    if (waitlist) {
      return 'waitlist';
    }

    return registration.get('status');
  }

  public async run() {
    const table = await this.getOrCreateTable<ParticipantsRow>(
      ParticipantsReport.headers,
    );

    const camp = await new LoggedQuery(Camp).get(this.campId);
    winston.info('Reporting participants for camp', camp);

    const registrationsQuery = queryCampEntries(camp).limit(1000);
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
    winston.info('Temporarily cancelling all existing records');
    for (const registration of registrations) {
      for (const participant of registration.get('participantsArray') ?? []) {
        table.updateRows(['Registration Id', 'Participant Id'], {
          'Registration Id': registration.id,
          'Participant Id': participant.id,
          Status: 'cancelled',
        });
      }
    }
    await table.save(true);

    for (const registration of registrations) {
      for (const participant of registration.get('participantsArray') ?? []) {
        const firstName = registration.get('firstName')?.trim();
        const lastName = registration.get('lastName')?.trim();
        const campName = camp.get('name');

        const joinObjects = registration.get('sessionJoinObjects') ?? [];

        for (const joinObject of joinObjects) {
          const campSession = joinObject.get('campSessionObject');
          const campClass = joinObject.get('campClassObject');
          const className = campClass.get('name');
          const sessionName = campSession.get('name') ?? 'Cancelled';

          const result = table.addOrUpdate(
            ['Registration Id', 'Participant Id', 'Class', 'Session'],
            {
              'Registration Id': registration.id,
              'Participant Id': participant.id,
              'Session Join Id': joinObject.id,
              'First Name': firstName,
              'Last Name': lastName,
              Camp: campName,
              Class: className,
              Session: sessionName,
              'Session Start': this.formatDate(campSession.get('startDate')),
              Status: this.calculateStatus(registration, joinObject),
              'Registration Date': this.formatDate(
                registration.get('confirmed_at'),
              ),
              'Date of Birth': this.formatDate(participant.get('DOB')),
              Gender: participant.get('gender'),

              Email: participant.get('email'),
              Mobile: participant.get('mobile'),
              'Postal Code': participant.get('zip'),

              'Emergency Contact': participant.get('emergencyContact'),
              'Emergency Contact Mobile': participant.get('emergencyMobile'),

              'First Guardian': participant.get('parentGuardianName'),
              'First Guardian Email': participant.get('parentGuardianEmail'),
              'First Guardian Mobile': participant.get('parentGuardianMobile'),

              'Second Guardian': participant.get(
                'parentGuardianName_secondary',
              ),
              'Second Guardian Email': participant.get(
                'parentGuardianEmail_secondary',
              ),
              'Second Guardian Mobile': participant.get(
                'parentGuardianMobile_secondary',
              ),

              'Medical Details': participant.get('medical'),
              Allergies: participant.get('medical_allergies'),
              Medication: participant.get('medical_meds'),
              'Last Tetanus Shot': participant.get('medical_tetanus'),
            },
          );

          if (!result.existing) {
            await this.notifier.sendMessage(
              `*${firstName} ${lastName}* registered for *${campName}*: ${className}, ${sessionName}!`,
            );
          }
        }
      }
    }

    await table.save();
  }
}
