#!/usr/bin/env -S npx tsx

import {
  Command,
  InvalidArgumentError,
  Option,
} from '@commander-js/extra-typings';
import { Clubspot } from '../src/clubspot.js';
import winston from 'winston';
import { consoleFormat } from 'winston-console-format';
import { Parse, schemas } from './parse.js';
import { Club, UserClub } from './types.js';

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
    return new Parse.Query(Club).get(clubId);
  } catch {
    throw new InvalidArgumentError(`No club with id ${clubId} exists.`);
  }
}

function configureLogging(pretty: boolean, debug: boolean, colors: boolean) {
  const formats = [
    winston.format.timestamp(),
    winston.format.ms(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ];

  if (colors) {
    formats.push(winston.format.colorize());
  }

  if (pretty) {
    formats.push(
      consoleFormat({
        showMeta: true,
        metaStrip: ['timestamp'],
        inspectOptions: {
          depth: Infinity,
          colors: colors,
          maxArrayLength: Infinity,
          breakLength: 120,
          compact: Infinity,
        },
      }),
    );
  }

  winston.configure({
    level: debug ? 'debug' : 'info',
    format: winston.format.combine(...formats),
    transports: new winston.transports.Console(),
  });
}

const clubspot = new Clubspot();

export const program = new Command('clubspot')
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
  .addOption(
    new Option('--debug', 'Enable debug-level logging')
      .default(false)
      .env('DEBUG'),
  )
  .addOption(new Option('--no-pretty'))
  .addOption(new Option('--no-colors'))
  .hook('preAction', async (command, action) => {
    const opts = command.opts();
    configureLogging(opts.pretty, opts.debug, opts.colors);
    await clubspot.initialize(opts.username, opts.password);

    winston.debug('Executing action', {
      action: action.args.join(' '),
      options: action.opts(),
    });
  });

program
  .command('whoami')
  .alias('who')
  .action(async () => {
    const query = new Parse.Query(UserClub)
      .include('clubObject')
      .equalTo('userObject', clubspot.user);

    const results = await query.find();

    const table = results.map((userClub) => {
      const club = userClub.get('clubObject');
      return {
        id: club.id,
        name: club.get('name'),
        admin: userClub.get('admin'),
        manager: userClub.get('manager'),
        permissions: userClub.get('permissions'),
      };
    });

    console.table(table);
  });

for (const schema of schemas) {
  const subcommand = program.command(schema.objectClass);
  const query = new Parse.Query(schema.objectClass);

  subcommand.command('get <id>').action(async (objectId) => {
    const result = await query.get(objectId);
    console.log(result.toJSON());
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

      winston.debug('Executing query', query.toJSON());

      const results = await query.find();
      const mapped = results.map((result) => result.toJSON());
      console.log(mapped);
    });
}

await program.parseAsync();
