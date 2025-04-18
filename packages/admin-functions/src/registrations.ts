import { Camp, Registration, LoggedQuery } from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report } from './reports.js';
import { HeaderValues } from './spreadsheets.js';
import { DateTime } from 'luxon';

type RegistrationsRow = {
  'Registration Id': string;
  'Registration Date': string;
  Participant: string;
  Camp: string;
  Classes: string;
  Sessions: string;
  Payment: number;
  Paid: boolean;
  Signatures: string | undefined;
  Status: string | undefined;
  Archived: boolean;
  Deferred: number;
  Pending: number;
  Received: number;
  Discount: number;
  Refunded: number;
};

function formatCurrency(amount: number | undefined) {
  if (amount === undefined) {
    return 0;
  } else {
    return amount / 100;
  }
}

export class RegistrationsReport extends Report {
  static headers = [
    'Registration Id',
    'Registration Date',
    'Participant',
    'Camp',
    'Classes',
    'Sessions',
    'Signatures',
    'Status',
    'Archived',
    'Deferred',
    'Pending',
    'Received',
    'Discount',
    'Refunded',
  ] satisfies HeaderValues<RegistrationsRow>;

  get campId() {
    return this.arguments;
  }

  public async run() {
    const table = await this.getOrCreateTable<RegistrationsRow>(
      RegistrationsReport.headers,
    );

    const camp = await new LoggedQuery(Camp).get(this.campId);
    winston.info('Reporting registrations for camp', camp);

    const registrationsQuery = new LoggedQuery(Registration)
      .equalTo('campObject', camp)
      .include('classes')
      .include('sessions')
      .include('billing_registration')
      .limit(1000);

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

      const billing = registration.get('billing_registration');

      const result = await table.addOrUpdate(['Registration Id'], {
        'Registration Id': registrationId,
        Camp: camp.get('name'),
        'Registration Date': this.formatDate(
          registration.get('confirmed_at'),
          DateTime.DATETIME_SHORT_WITH_SECONDS,
        ),
        Participant: participant,
        Sessions: sessions,
        Classes: classes,
        Signatures: registration.get('waiver_status'),
        Status: registration.get('status'),
        Archived: registration.get('archived') ?? false,
        Deferred: formatCurrency(billing?.get('amount_deferred')),
        Pending: formatCurrency(billing?.get('amountPending')),
        Received: formatCurrency(billing?.get('amount_received')),
        Discount: formatCurrency(billing?.get('discount')),
        Refunded: formatCurrency(billing?.get('amountRefunded')),
      });

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

    await table.save();
  }
}
