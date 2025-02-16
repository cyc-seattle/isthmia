import { Camp, Registration } from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { executeQuery, Report } from './reports.js';
import Parse from 'parse/node.js';
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

  public async run(campId: string, sheet: string) {
    const table = await this.spreadsheet.getOrCreateTable<RegistrationsRow>(
      sheet,
      RegistrationsReport.headers,
    );

    const camp = await new Parse.Query(Camp).get(campId);
    winston.info('Reporting registrations for camp', camp);

    const registrations = await executeQuery(
      new Parse.Query(Registration)
        .equalTo('campObject', camp)
        .exists('confirmed_at')
        .include('classes')
        .include('sessions')
        .addDescending('confirmed_at'),
    );

    for (const registration of registrations) {
      const registrationId = registration.id;
      const firstName = registration.get('firstName');
      const lastName = registration.get('lastName');
      //const billing = registration.get('billing_registration');

      winston.debug('registration', registration.toJSON());

      // TODO
      const payment = 0;
      const paid = false;

      await table.addOrUpdate(
        (row) => row.get('registrationId') == registrationId,
        {
          registrationId,
          camp: camp.get('name'),
          confirmedOn:
            registration.get('confirmed_at')?.toLocaleDateString('en-US') ?? '',
          participant: `${firstName} ${lastName}`,
          classes:
            registration
              .get('classes')
              ?.map((session) => session.get('name'))
              .join(', ') ?? '',
          sessions:
            registration
              .get('sessions')
              ?.map((session) => session.get('name'))
              .join(', ') ?? '',
          payment: payment,
          paid: paid,
          signatures: registration.get('waiver_status'),
          status: registration.get('status'),
          archived: registration.get('archived'),
        },
      );
    }
  }
}
