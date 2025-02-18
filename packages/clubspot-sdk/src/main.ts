#!/usr/bin/env -S npx tsx

import {
  Command,
  InvalidArgumentError,
  Option,
} from '@commander-js/extra-typings';
import { Clubspot } from '../src/clubspot.js';
import winston from 'winston';
import { LoggedQuery, schemas } from './parse.js';
import { Club, UserClub } from './types.js';
import { LoggingOption, OutputOption, VerboseOption } from './commodore.js';

function parseIntOption(value: string) {
  const parsed = parseInt(value);
  if (isNaN(parsed)) {
    throw new InvalidArgumentError('Not a number');
  }
  return parsed;
}

interface Filter {
  attribute: string;
  value: string;
}

/**
 * TODO Support more complicated filters. I don't like this simple parsing.
 */
function parseFilterOption(value: string, previous: Filter[]) {
  const parsed = value.split('=');
  if (parsed.length != 2) {
    throw new InvalidArgumentError('Expected format: <attribute>=<value>');
  }

  const filter: Filter = {
    attribute: parsed[0]!,
    value: parsed[1]!,
  };

  return previous.concat([filter]);
}

function getClub(clubId: string): Promise<Club> {
  try {
    return new LoggedQuery(Club).get(clubId);
  } catch {
    throw new InvalidArgumentError(`No club with id ${clubId} exists.`);
  }
}

const clubspot = new Clubspot();

// A separate logger to use for the output of commands.  Writes to stdout.
// This outputLogger will get overwritten by a fully configured logger during the preAction hook.
let outputLogger = winston.child({});

const program = new Command('clubspot')
  .addOption(
    new Option('-u, --username <username>')
      .env('CLUBSPOT_EMAIL')
      .makeOptionMandatory(),
  )
  .addOption(
    new Option('-p, --password <password>')
      .env('CLUBSPOT_PASSWORD')
      .makeOptionMandatory(),
  )
  .addOption(new OutputOption())
  .addOption(new LoggingOption())
  .addOption(new VerboseOption())
  .hook('preAction', async (command, action) => {
    const opts = command.opts();

    winston.configure({
      level: opts.verbose ?? 'warn',
      format: opts.logging,
      transports: new winston.transports.Stream({ stream: process.stderr }),
    });

    outputLogger = winston.createLogger({
      level: 'info',
      format: opts.format,
      transports: new winston.transports.Console(),
    });

    await clubspot.initialize(opts.username, opts.password);

    winston.debug('Executing action', {
      action: action.args.join(' '),
      options: action.opts(),
    });
  });

program
  .command('whoami')
  .description(
    'Lookup your Clubspot user information and what clubs you are assigned to.',
  )
  .alias('who')
  .action(async () => {
    const query = new LoggedQuery(UserClub)
      .include('clubObject')
      .equalTo('userObject', clubspot.user);

    const results = await query.find();

    const clubs = results.map((userClub) => {
      const club = userClub.get('clubObject');
      return {
        id: club.id,
        name: club.get('name'),
        admin: userClub.get('admin'),
        manager: userClub.get('manager'),
        permissions: userClub.get('permissions'),
      };
    });

    outputLogger.info({
      user: clubspot.user.toJSON(),
      clubs,
    });
  });

for (const schema of schemas) {
  const subcommand = program.command(schema.objectClass);
  const query = new LoggedQuery(schema.objectClass);

  subcommand.command('get <id>').action(async (objectId) => {
    const result = await query.get(objectId);
    outputLogger.info(result.toJSON());
  });

  // TODO: .addOption(super("--club <id>", "The id of the Clubspot club to limit results to.");
  subcommand
    .command('list')
    .alias('ls')
    .addOption(
      new Option('-c, --club <id>')
        .env('CLUBSPOT_CLUB_ID')
        .makeOptionMandatory(),
    )
    .option(
      '--limit <number>',
      'The number of results to return.',
      parseIntOption,
      10,
    )
    .option(
      '--include <attributes...>',
      'Attributes to include in the returned result.',
    )
    .option(
      '--sort <attributes...>',
      'Repeatable list of attributes to sort by. Default ascending, start with "-" if you want descending.',
    )
    .option(
      '--filter <attribute>=<value>',
      'Filters the results where attribute == value. Repeatable',
      parseFilterOption,
      [],
    )
    .action(async (options) => {
      // TODO: Not every class is filtered on clubObject.
      const club = await getClub(options.club);
      query.include('clubObject').equalTo('clubObject', club);

      query.limit(options.limit);

      if (options.include) {
        query.include(...options.include);
      }

      for (const filter of options.filter) {
        query.equalTo(filter.attribute, filter.value);
      }

      for (const sortClause of options.sort ?? []) {
        if (sortClause.startsWith('-')) {
          query.addDescending(sortClause.substring(1));
        } else {
          query.addAscending(sortClause);
        }
      }

      const results = await query.find();
      const mapped = results.map((result) => result.toJSON());
      outputLogger.info(mapped);
    });
}

await program.parseAsync();
