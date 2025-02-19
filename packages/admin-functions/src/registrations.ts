import { Camp, Registration, LoggedQuery } from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report } from './reports.js';
import { RowKeys } from './spreadsheets.js';

interface RegistrationsRow {
  registrationId: string;
  camp: string;
  confirmedOn: string;
  participant: string;
  classes: string;
  sessions: string;
  payment: number;
  paid: boolean;
  signatures: string;
  status: string;
  archived: boolean;
}

export class RegistrationsReport extends Report {
  static headers = [
    'registrationId',
    'camp',
    'confirmedOn',
    'participant',
    'classes',
    'sessions',
    'payment',
    'paid',
    'signatures',
    'status',
    'archived',
  ] satisfies RowKeys<RegistrationsRow>;

  get campId() {
    return this.arguments;
  }

  public async run() {
    const table = await this.spreadsheet.getOrCreateTable<RegistrationsRow>(
      this.sheetName,
      RegistrationsReport.headers,
    );

    const camp = await new LoggedQuery(Camp).get(this.campId);
    winston.info('Reporting registrations for camp', camp);

    const registrationsQuery = new LoggedQuery(Registration)
      .equalTo('campObject', camp)
      .exists('confirmed_at')
      .include('classes')
      .include('sessions')
      .addDescending('confirmed_at');

    const registrations = await this.updatedBetween(registrationsQuery).find();

    for (const registration of registrations) {
      const registrationId = registration.id;
      const firstName = registration.get('firstName')?.trim();
      const lastName = registration.get('lastName')?.trim();
      const participant = `${firstName} ${lastName}`;
      const sessions =
        registration
          .get('sessions')
          ?.map((session) => session.get('name'))
          .join(', ') ?? '';
      const classes =
        registration
          .get('classes')
          ?.map((session) => session.get('name'))
          .join(', ') ?? '';
      //const billing = registration.get('billing_registration');

      winston.debug('registration', registration.toJSON());

      // TODO
      const payment = 0;
      const paid = false;

      const result = await table.addOrUpdate(
        (row) => row.get('registrationId') == registrationId,
        {
          registrationId,
          camp: camp.get('name'),
          confirmedOn:
            registration.get('confirmed_at')?.toLocaleDateString('en-US') ?? '',
          participant,
          sessions,
          classes,
          payment,
          paid,
          signatures: registration.get('waiver_status'),
          status: registration.get('status'),
          archived: registration.get('archived'),
        },
      );

      if (result.existing) {
        await this.notifier.sendMessage(
          `*${participant}'s* registration for *${camp.get('name')}* was updated.`,
        );
      } else {
        await this.notifier.sendMessage(
          `*${participant}* registered for *${camp.get('name')}*: ${sessions}, ${classes}!`,
        );
      }
    }
  }
}
