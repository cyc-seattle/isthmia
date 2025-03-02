import { Camp, Club, LoggedQuery } from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report } from './reports.js';
import { HeaderValues } from './spreadsheets.js';

type CampRow = {
  'Camp Id': string;
  Name: string;
  'Start Date': string;
  Open: boolean;
  'Registration Link': string;
  'Entry List': string;
};

export class CampsReport extends Report {
  static headers = [
    'Camp Id',
    'Name',
    'Start Date',
    'Open',
    'Registration Link',
    'Entry List',
  ] satisfies HeaderValues<CampRow>;

  static keyHeaders = ['Camp Id'] satisfies HeaderValues<CampRow>;

  get clubId() {
    return this.arguments;
  }

  public async run() {
    const table = await this.getOrCreateTable(CampsReport.headers);

    const club = await new LoggedQuery(Club).get(this.clubId);
    winston.info('Reporting camps for club', club);

    const campsQuery = new LoggedQuery(Camp)
      .equalTo('clubObject', club)
      .equalTo('archived', false)
      .addDescending('startDate');

    const camps = await this.updatedBetween(campsQuery).find();

    for (const camp of camps) {
      const campId = camp.id;

      await table.addOrUpdate(CampsReport.keyHeaders, {
        'Camp Id': campId,
        Name: camp.get('name'),
        'Start Date': this.formatDate(camp.get('startDate')),
        Open: !(camp.get('registration_closed') ?? false),
        'Registration Link': `https://theclubspot.com/register/camp/${campId}/class`,
        'Entry List': `https://theclubspot.com/dashboard/camp/${campId}/entry-list`,
      });
    }

    await table.save();
  }
}
