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
import { HeaderValues } from './spreadsheets.js';

type SessionRow = {
  'Class Id': string;
  'Session Id': string;
  Camp: string;
  Class: string;
  Session: string;
  'Start Date': string;
  'End Date': string;
  Capacity: number | undefined;
  Confirmed: number;
  Waitlist: number;
};

export class SessionsReport extends Report {
  static headers = [
    'Class Id',
    'Session Id',
    'Camp',
    'Class',
    'Session',
    'Start Date',
    'End Date',
    'Capacity',
    'Confirmed',
    'Waitlist',
  ] satisfies HeaderValues<SessionRow>;

  get campId() {
    return this.arguments;
  }

  public async run() {
    const table = await this.getOrCreateTable<SessionRow>(
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
    const campSessions = await new LoggedQuery(CampSession)
      .equalTo('campObject', camp)
      .notEqualTo('archived', true)
      .include('campClassesArray')
      // @ts-expect-error - The Parse Typescript SDK isn't quite good enough to validate nested includes.
      .include('campClassesArray.entryCapsArray')
      .find();

    const campRegistrations = await new LoggedQuery(RegistrationCampSession)
      .equalTo('campObject', camp)
      .notEqualTo('archived', true)
      .limit(1000)
      .find();

    for (const campSession of campSessions) {
      const sessionName = campSession.get('name');
      const sessionForAllClasses = campSession.get('allClasses') ?? false;
      const campClasses = campSession.get('campClassesArray') ?? allClasses;

      for (const campClass of campClasses) {
        const className = campClass.get('name');

        function registrationPredicate(registration: RegistrationCampSession) {
          const sessionId = registration.get('campSessionObject').id;
          const classId = registration.get('campClassObject').id;
          return sessionId == campSession.id && classId == campClass.id;
        }

        const registrations = campRegistrations.filter(registrationPredicate);

        const confirmed = registrations.filter(
          (reg) => reg.get('confirmed_at') !== undefined,
        ).length;
        const waitlist = registrations.filter(
          (reg) => reg.get('waitlist') ?? false,
        ).length;

        function entryCapPredicate(cap: EntryCap) {
          const archived = cap.get('archived') ?? false;
          const sessionId = cap.get('campSessionObject')?.id;
          // Entry cap objects with no session relate to sessions marked as "all classes".
          const relatesToAllSessions =
            sessionForAllClasses && sessionId === undefined;
          const relatesToThisSession = sessionId == campSession.id;
          const relatedToSession = relatesToAllSessions || relatesToThisSession;
          return !archived && relatedToSession;
        }

        const entryCaps = campClass
          .get('entryCapsArray')
          ?.filter(entryCapPredicate);

        const capacity = entryCaps
          ?.map((cap) => cap.get('cap') ?? 0)
          .reduce((prev, curr) => prev + curr, 0);

        await table.addOrUpdate(['Class Id', 'Session Id'], {
          'Class Id': campClass.id,
          'Session Id': campSession.id,
          Camp: campName,
          Session: sessionName,
          Class: className,
          'Start Date': this.formatDate(campSession.get('startDate')),
          'End Date': this.formatDate(campSession.get('endDate')),
          Capacity: capacity,
          Confirmed: confirmed,
          Waitlist: waitlist,
        });
      }
    }

    await table.save();
  }
}
