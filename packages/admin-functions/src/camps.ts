import { Camp, Club, LoggedQuery } from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report } from './reports.js';
import { RowKeys } from './spreadsheets.js';

interface CampRow {
  campId: string;
  name: string;
  startDate: string;
  open: boolean;
  registrationLink: string;
  entryList: string;
}

export class CampsReport extends Report {
  static headers = [
    'campId',
    'name',
    'startDate',
    'open',
    'registrationLink',
    'entryList',
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

      await table.addOrUpdate((row) => row.get('campId') == campId, {
        campId,
        name: camp.get('name'),
        startDate: camp.get('startDate')?.toLocaleDateString('en-US'),
        open: !(camp.get('registration_closed') ?? false),
        registrationLink: `https://theclubspot.com/register/camp/${campId}/class`,
        entryList: `https://theclubspot.com/dashboard/camp/${campId}/entry-list`,
      });
    }
  }
}
