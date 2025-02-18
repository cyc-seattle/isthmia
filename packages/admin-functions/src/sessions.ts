import {
  Camp,
  CampSession,
  EntryCap,
  RegistrationCampSession,
} from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report, executeQuery } from './reports.js';
import Parse from 'parse/node.js';
import { RowKeys } from './spreadsheets.js';
import { GoogleSpreadsheetRow } from 'google-spreadsheet';

interface SessionRow {
  camp: string;
  class: string;
  session: string;
  start: string;
  end: string;
  capacity: number;
  confirmed: number;
  waitlist: number;
}

export class SessionsReport extends Report {
  static headers = [
    'camp',
    'class',
    'session',
    'start',
    'end',
    'capacity',
    'confirmed',
    'waitlist',
  ] satisfies RowKeys<SessionRow>;

  public async run(campId: string, sheet: string) {
    const table = await this.spreadsheet.getOrCreateTable<SessionRow>(
      sheet,
      SessionsReport.headers,
    );

    const camp = await new Parse.Query(Camp).get(campId);
    const campName = camp.get('name');
    winston.info('Reporting sessions and classes for camp', {
      campId,
      campName,
    });

    const sessions = await executeQuery(
      new Parse.Query(CampSession)
        .equalTo('campObject', camp)
        .notEqualTo('archived', true)
        .include('campClassesArray')
        // @ts-expect-error - The Parse Typescript SDK isn't quite good enough to validate nested includes.
        .include('campClassesArray.entryCapsArray'),
    );

    const registrations = await executeQuery(
      new Parse.Query(RegistrationCampSession).equalTo('campObject', camp),
    );

    for (const session of sessions) {
      const sessionName = session.get('name');
      // TODO: Does a session with allClasses == true define campClassesArray as well?
      const campClasses = session.get('campClassesArray') ?? [];

      for (const campClass of campClasses) {
        const className = campClass.get('name');

        function registrationPredicate(registration: RegistrationCampSession) {
          const sessionId = registration.get('campSessionObject').id;
          const classId = registration.get('campClassObject').id;
          return sessionId == session.id && classId == classId;
        }

        // TODO: Technically, I think it's possible that registrations can be for multiple participants, but I don't
        // think Clubspot does it anymore, so assuming 1 participant per registration should be safe.
        // NOTE: It _is_ possible for one registration to be for multiple class/sessions.
        const confirmed = registrations.filter(
          (reg) =>
            registrationPredicate(reg) && reg.get('confirmed_at') !== undefined,
        ).length;

        const waitlist = registrations.filter(
          (reg) => registrationPredicate(reg) && reg.get('waitlist'),
        ).length;

        function entryCapPredicate(cap: EntryCap) {
          const sessionId = cap.get('campSessionObject')?.id;
          return sessionId === session.id;
        }

        const capacity = campClass
          .get('entryCapsArray')
          ?.filter(entryCapPredicate)
          .map((cap) => cap.get('cap'))
          .reduce((prev, curr) => prev + curr, 0);

        function rowPredicate(row: GoogleSpreadsheetRow<SessionRow>) {
          return (
            row.get('camp') == campName &&
            row.get('session') == sessionName &&
            row.get('class') == className
          );
        }

        await table.addOrUpdate(rowPredicate, {
          camp: campName,
          session: sessionName,
          class: className,
          start: session.get('startDate')?.toLocaleDateString('en-US'),
          end: session.get('endDate')?.toLocaleDateString('en-US'),
          capacity,
          confirmed,
          waitlist,
        });
      }
    }
  }
}
