#!/usr/bin/env -S npx tsx

import { Command } from '@commander-js/extra-typings';
import { LoggingOption, VerboseOption } from '@cyc-seattle/commodore';
import winston from 'winston';
import { TodoistClient } from './todoist.js';
import { TodoistTokenOption } from './options.js';
import { Camp, CampSession, Clubspot, ClubspotPasswordOption, ClubspotUsernameOption, LoggedQuery } from '@cyc-seattle/clubspot-sdk';
import { DateTime, Duration } from 'luxon';

const clubspot = new Clubspot();
const todoist = new TodoistClient();

const program = new Command('todo-manager')
  .addOption(new LoggingOption())
  .addOption(new VerboseOption('info'))
  .addOption(new ClubspotUsernameOption())
  .addOption(new ClubspotPasswordOption())
  .addOption(new TodoistTokenOption())
  .hook('preAction', async (command, action) => {
    const opts = command.opts();

    winston.configure({
      level: opts.verbose ?? 'info',
      format: opts.logging,
      transports: new winston.transports.Stream({ stream: process.stderr }),
    });

    await clubspot.initialize(opts.username, opts.password);
    await todoist.initialize(opts.token);

    winston.debug('Executing action', {
      action: action.name(),
      options: action.opts(),
    });
  });

program.command('camp-emails')
  .description('Creates a new todoist project for each session of a camp')
  .requiredOption('--camp <camp id>', 'The id of the clubspot camp to create projects for.')
  .requiredOption('--parent <project name>', 'The project name to parent created projects under.')
  .action(async (options) => {

    const parentProject = todoist.getProject(options.parent);
    if(parentProject === undefined) {
      throw new Error(`Could not find a project with name ${options.parent}`);
    }

    const camp = await new LoggedQuery(Camp).get(options.camp);
    winston.info("Creating email projects for camp", {camp, parentProject});

    const campName = camp.get("name");
    const campSessions = await new LoggedQuery(CampSession)
      .equalTo('campObject', camp)
      .notEqualTo('archived', true)
      .include('campClassesArray')
      .find();

    for(const campSession of campSessions) {
      const startDate = DateTime.fromJSDate(campSession.get("startDate"));
      const endDate = DateTime.fromJSDate(campSession.get("endDate"));
      const projectName = `Emails ${campName} - ${startDate.toLocaleString(DateTime.DATE_SHORT)}`;

      const participantSheet = `https://docs.google.com/spreadsheets/d/12qrnXz0y9Wq4tV0_B64KFJZJph5-vbwfLxpB2w8rS1o/edit?gid=823472385#gid=823472385`;
      const buffer = Duration.fromObject({weeks: 1});
      const project = await todoist.getOrAddProject(parentProject, projectName, 'violet');

      async function scheduleEmailTask(emailName: string, emailTemplate: string, scheduledDate: DateTime) {
        await todoist.addTask({
          projectId: project.id,
          content: `Schedule ${emailName} for ${scheduledDate.toLocaleString(DateTime.DATE_SHORT)}`,
          description: `[Participants](${participantSheet})\n[Email Template](${emailTemplate})`,
          dueDate: scheduledDate.minus(buffer),
          priority: 4
        });
      }

      await scheduleEmailTask(
        "welcome email",
        "https://docs.google.com/document/d/1vGvec4h77BRJuD8VUuzVXKVYdKaXG2LmBeUsoI_ULrI/edit?tab=t.0",
        startDate.minus(Duration.fromObject({weeks: 3}))
      );

      await scheduleEmailTask(
        "reminder email",
        "https://docs.google.com/document/d/1vGvec4h77BRJuD8VUuzVXKVYdKaXG2LmBeUsoI_ULrI/edit?tab=t.vpd2auhd7c9v",
        startDate.minus(Duration.fromObject({weeks: 1}))
      );

      await scheduleEmailTask(
        "follow up email",
        "https://docs.google.com/document/d/1vGvec4h77BRJuD8VUuzVXKVYdKaXG2LmBeUsoI_ULrI/edit?tab=t.gm7e8beqox1y",
        endDate,
      );
    }
  });


await program.parseAsync();
