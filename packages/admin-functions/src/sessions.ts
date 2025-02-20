import {
  Camp,
  CampSession,
  EntryCap,
  RegistrationCampSession,
  LoggedQuery,
  CampClass,
} from '@cyc-seattle/clubspot-sdk';
import winston from 'winston';
import { Report } from './reports.js';
import { RowKeys } from './spreadsheets.js';
import { GoogleSpreadsheetRow } from 'google-spreadsheet';

interface SessionRow {
  Camp: string;
  Class: string;
  Session: string;
  'Start Date': string;
  'End Date': string;
  Capacity: number;
  Confirmed: number;
  Waitlist: number;
}

export class SessionsReport extends Report {
  static headers = [
    'Camp',
    'Class',
    'Session',
    'Start Date',
    'End Date',
    'Capacity',
    'Confirmed',
    'Waitlist',
  ] satisfies RowKeys<SessionRow>;

  get campId() {
    return this.arguments;
  }

  public async run() {
    const table = await this.spreadsheet.getOrCreateTable<SessionRow>(
      this.sheetName,
      SessionsReport.headers,
    );

    const camp = await new LoggedQuery(Camp).get(this.campId);
    const campName = camp.get('name');
    winston.info('Reporting sessions and classes for camp', {
      id: this.campId,
      campName,
    });

    const allClasses = await new LoggedQuery(CampClass)
      .equalTo('campObject', camp)
      .find();

    // NOTE: This query is not filtered on the report interval, because too many other things (classes, sessions, caps)
    // may have changed, so we'll just update them every time.
    const sessions = await new LoggedQuery(CampSession)
      .equalTo('campObject', camp)
      .notEqualTo('archived', true)
      .include('campClassesArray')
      // @ts-expect-error - The Parse Typescript SDK isn't quite good enough to validate nested includes.
      .include('campClassesArray.entryCapsArray')
      .find();

    const registrations = await new LoggedQuery(RegistrationCampSession)
      .equalTo('campObject', camp)
      .find();

    for (const session of sessions) {
      const sessionName = session.get('name');
      const campClasses = session.get('campClassesArray') ?? allClasses;

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
          // Entry cap objects with no session relate to sessions marked as "all classes".
          return sessionId === undefined || sessionId === session.id;
        }

        const capacity = campClass
          .get('entryCapsArray')
          ?.filter(entryCapPredicate)
          .map((cap) => cap.get('cap'))
          .reduce((prev, curr) => prev + curr, 0);

        function rowPredicate(row: GoogleSpreadsheetRow<SessionRow>) {
          return (
            row.get('Camp') == campName &&
            row.get('Session') == sessionName &&
            row.get('Class') == className
          );
        }

        await table.addOrUpdate(rowPredicate, {
          Camp: campName,
          Session: sessionName,
          Class: className,
          'Start Date': session.get('startDate')?.toLocaleDateString('en-US'),
          'End Date': session.get('endDate')?.toLocaleDateString('en-US'),
          Capacity: capacity,
          Confirmed: confirmed,
          Waitlist: waitlist,
        });
      }
    }
  }
}
