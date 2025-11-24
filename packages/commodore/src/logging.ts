/**
 * Some extensions to commander.js
 */

import {
  InvalidOptionArgumentError,
  Option,
} from "@commander-js/extra-typings";
import logform from "logform";
import { inspect, InspectOptions } from "util";
import { consoleFormat } from "winston-console-format";

// Creates a parse function that looks up the result from a record.
function recordParser<T>(record: Record<string, T>) {
  return function (key: string) {
    const value = record[key];
    if (value === undefined) {
      const formats = Object.keys(record).join(", ");
      throw new InvalidOptionArgumentError(`Must be one of: ${formats}`);
    }
    return value;
  };
}

const inspectOptions: InspectOptions = {
  depth: 3,
  colors: true,
  sorted: true,
  numericSeparator: true,
};

const outputFormats: Record<string, logform.Format> = {
  pretty: logform.format.printf((info) =>
    inspect(info.message, inspectOptions),
  ),
  json: logform.format.printf((info) => JSON.stringify(info.message)),
};

/**
 * Creates a --format option that selects from one of several logform formats.
 */
export class OutputOption extends Option<
  "--format <format>",
  undefined,
  logform.Format,
  logform.Format,
  false,
  keyof typeof outputFormats
> {
  constructor() {
    super("--format <format>", "Configures the output format.");
    this.choices(Object.keys(outputFormats));
    this.default(outputFormats["pretty"], "pretty");
    this.argParser(recordParser(outputFormats));
  }
}

const plainFormat = logform.format.combine(
  logform.format.timestamp(),
  logform.format.ms(),
  logform.format.errors({ stack: true }),
  logform.format.json(),
);

const loggingFormats: Record<string, logform.Format> = {
  json: plainFormat,
  pretty: logform.format.combine(
    plainFormat,
    logform.format.colorize(),
    consoleFormat({
      showMeta: true,
      metaStrip: ["timestamp"],
      inspectOptions: {
        depth: Infinity,
        colors: true,
        maxArrayLength: Infinity,
        breakLength: 120,
        compact: Infinity,
      },
    }),
  ),
};

/**
 * Creates a --logging option
 */
export class LoggingOption extends Option<
  "--logging <format>",
  undefined,
  logform.Format,
  logform.Format,
  false,
  keyof typeof loggingFormats
> {
  constructor() {
    super("--logging <format>", "Configures the logging format to use.");
    this.choices(Object.keys(loggingFormats));
    this.default(loggingFormats["pretty"], "pretty");
    this.argParser(recordParser(loggingFormats));
  }
}

const logLevels = ["error", "warn", "info", "debug"] as const;
type LogLevelsT = (typeof logLevels)[number];

/**
 * A repeatable --verbose option that can be used to set a log level.
 */
export class VerboseOption extends Option<
  "-v, --verbose",
  LogLevelsT,
  undefined,
  undefined,
  false,
  undefined
> {
  readonly startLevel: LogLevelsT;

  constructor(startLevel?: LogLevelsT) {
    super("-v, --verbose", "Increases the log level. Can be repeated.");
    this.startLevel = startLevel ?? "warn";
    this.argParser(this.parse);
  }

  // Increase the verbosity every time the option is given.
  private parse(_: string, previous?: LogLevelsT): LogLevelsT {
    const next = logLevels.indexOf(previous ?? this.startLevel) + 1;
    return logLevels[next] ?? "debug"; // Return debug if we exceed the length of the array.
  }
}
