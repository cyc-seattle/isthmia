import { Camp, Club, LoggedQuery } from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report } from './reports.js';
import { RowKeys } from './spreadsheets.js';

interface CampRow {
  'Camp Id': string;
  Name: string;
  'Start Date': string;
  Open: boolean;
  'Registration Link': string;
  'Entry List': string;
}

export class CampsReport extends Report {
  static headers = [
    'Camp Id',
    'Name',
    'Start Date',
    'Open',
    'Registration Link',
    'Entry List',
  ] satisfies RowKeys<CampRow>;

  get clubId() {
    return this.arguments;
  }

  public async run() {
    const table = await this.spreadsheet.getOrCreateTable<CampRow>(
      this.sheetName,
      CampsReport.headers,
    );

    const club = await new LoggedQuery(Club).get(this.clubId);
    winston.info('Reporting camps for club', club);

    const campsQuery = new LoggedQuery(Camp)
      .equalTo('clubObject', club)
      .equalTo('archived', false)
      .addDescending('startDate');

    const camps = await this.updatedBetween(campsQuery).find();

    for (const camp of camps) {
      const campId = camp.id;

      await table.addOrUpdate((row) => row.get('Camp Id') == campId, {
        'Camp Id': campId,
        Name: camp.get('name'),
        'Start Date': camp.get('startDate')?.toLocaleDateString('en-US'),
        Open: !(camp.get('registration_closed') ?? false),
        'Registration Link': `https://theclubspot.com/register/camp/${campId}/class`,
        'Entry List': `https://theclubspot.com/dashboard/camp/${campId}/entry-list`,
      });
    }
  }
}
