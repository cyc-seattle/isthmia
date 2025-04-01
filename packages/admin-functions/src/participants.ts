import { Camp, queryCampEntries, LoggedQuery } from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report } from './reports.js';
import { HeaderValues } from './spreadsheets.js';

type ParticipantsRow = {
  readonly 'Registration Id': string;
  readonly 'Participant Id': string;
  readonly 'First Name': string;
  readonly 'Last Name': string;

  readonly Camp: string;
  readonly Class: string;
  readonly Session: string;
  readonly Status: string;
  readonly 'Registration Date': string;

  readonly 'Date of Birth': string;
  readonly Gender: string;
  readonly Email: string;
  readonly Mobile: string;
  readonly 'Postal Code': string;

  readonly 'First Guardian': string;
  readonly 'First Guardian Email': string;
  readonly 'First Guardian Mobile': string;

  readonly 'Second Guardian': string;
  readonly 'Second Guardian Email': string;
  readonly 'Second Guardian Mobile': string;

  readonly 'Emergency Contact': string;
  readonly 'Emergency Contact Mobile': string;

  readonly 'Medical Details': string;
  readonly Allergies: string;
  readonly Medication: string;
  readonly 'Last Tetanus Shot': string;
};

export class ParticipantsReport extends Report {
  static headers = [
    'Registration Id',
    'Participant Id',
    'First Name',
    'Last Name',

    'Camp',
    'Class',
    'Session',
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

  public async run() {
    const table = await this.getOrCreateTable<ParticipantsRow>(
      ParticipantsReport.headers,
    );

    const camp = await new LoggedQuery(Camp).get(this.campId);
    winston.info('Reporting participants for camp', camp);

    const registrationsQuery = queryCampEntries(camp).limit(1000);
    const registrations = await this.updatedBetween(registrationsQuery).find();

    for (const registration of registrations) {
      for (const joinObject of registration.get('sessionJoinObjects') ?? []) {
        const campSession = joinObject.get('campSessionObject');
        const campClass = joinObject.get('campClassObject');

        for (const participant of registration.get('participantsArray') ?? []) {
          const firstName = registration.get('firstName')?.trim();
          const lastName = registration.get('lastName')?.trim();
          const campName = camp.get('name');
          const className = campClass.get('name');
          const sessionName = campSession.get('name');
          const archived = registration.get('archived') ?? false;
          const status = archived ? 'cancelled' : registration.get('status');

          const keys = ['Registration Id', 'Class', 'Session'];

          const result = table.addOrUpdate(keys, {
            'Registration Id': registration.id,
            'Participant Id': participant.id,
            'First Name': firstName,
            'Last Name': lastName,
            Camp: campName,
            Class: className,
            Session: sessionName,
            Status: status,
            'Registration Date': this.formatDate(registration.get('confirmed_at')),
            'Date of Birth': this.formatDate(participant.get('DOB')),
            Gender: participant.get('gender'),

            Email: participant.get('email'),
            Mobile: participant.get('mobile'),
            'Postal Code': participant.get('zip'),

            'Emergency Contact': participant.get('emergencyContact'),
            'Emergency Contact Mobile': participant.get('emergencyMobile'),
            'Emergency Contact Relationship': participant.get(
              'emergencyRelationship',
            ),

            'First Guardian': participant.get('parentGuardianName'),
            'First Guardian Email': participant.get('parentGuardianEmail'),
            'First Guardian Mobile': participant.get('parentGuardianMobile'),

            'Second Guardian': participant.get('parentGuardianName_secondary'),
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
          });

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
