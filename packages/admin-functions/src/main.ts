#!/usr/bin/env -S npx tsx

import { Command, Option } from '@commander-js/extra-typings';
import winston from 'winston';
import {
  Clubspot,
  LoggingOption,
  VerboseOption,
} from '@cyc-seattle/clubspot-sdk';
import { Auth, google } from 'googleapis';
import { ReportRunner } from './runner.js';

// Outh Scopes: https://developers.google.com/identity/protocols/oauth2/scopes
const auth: Auth.GoogleAuth = new google.auth.GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/cloud-platform',
  ],
});

const clubspot = new Clubspot();
const reportRunner = new ReportRunner(auth);

// TODO: dry run option
const program = new Command('admin-scripts')
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
  .addOption(new LoggingOption())
  .addOption(new VerboseOption('info'))
  .hook('preAction', async (command, action) => {
    const opts = command.opts();

    winston.configure({
      level: opts.verbose ?? 'info',
      format: opts.logging,
      transports: new winston.transports.Stream({ stream: process.stderr }),
    });

    await clubspot.initialize(opts.username, opts.password);

    winston.debug('Executing action', {
      action: action.name(),
      options: action.opts(),
    });
  });

const configSheetOption = new Option(
  '--config-spreadsheet <id>',
  'The ID of the configuration spreadsheet',
)
  .env('CONFIG_SPREADSHEET_ID')
  .makeOptionMandatory();

program
  .command('all')
  .description('Runs all reports defined in the specified config spreadsheet.')
  .addOption(configSheetOption)
  .action(async (options) => {
    await reportRunner.runAll(options.configSpreadsheet);
  });

try {
  await program.parseAsync();
} catch (error) {
  winston.error('Unhandled error', { error });
  process.exit(-1);
}
