import { LoggedQuery } from './parse.js';
import { Camp, Registration } from './types.js';

/**
 * Returns a query that is similar to that used on the Camps->Entries page of the Clubspot dashboard.
 *
 * Includes only confirmed registrations, but does NOT filter out archived (cancelled).
 */
export function queryCampEntries(camp: Camp): LoggedQuery<Registration> {
  return (
    new LoggedQuery(Registration)
      .equalTo('campObject', camp)
      .exists('confirmed_at')
      .include('classes')
      .include('sessions')
      // @ts-expect-error - The Parse Typescript SDK isn't quite good enough to validate nested includes.
      .include('sessionJoinObjects.campSessionObject')
      // @ts-expect-error - The Parse Typescript SDK isn't quite good enough to validate nested includes.
      .include('sessionJoinObjects.campClassObject')
      .include('participantsArray')
  );
}
