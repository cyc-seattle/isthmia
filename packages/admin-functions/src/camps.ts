import { Camp, Club } from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report, executeQuery } from './reports.js';
import Parse from 'parse/node.js';
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

  public async run(clubId: string, sheet: string) {
    const table = await this.spreadsheet.getOrCreateTable<CampRow>(
      sheet,
      CampsReport.headers,
    );

    const club = await new Parse.Query(Club).get(clubId);
    winston.info('Reporting camps for club', club);

    const camps = await executeQuery(
      new Parse.Query(Camp)
        .equalTo('clubObject', club)
        .equalTo('archived', false)
        .addDescending('startDate'),
    );

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
