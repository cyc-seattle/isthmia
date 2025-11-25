# @cyc-seattle/calendar-sync

Syncs events from Google Spreadsheet to multiple Google Calendars.

## Features

- One-way sync from Google Spreadsheet to Google Calendar
- Support for multiple calendars in a single spreadsheet
- Event labeling/tagging system
- Automatic event creation and updates
- Skips tentative events (blank start dates)
- CLI tool and library API
- Rate-limited API calls to respect Google's quotas

## Installation

```bash
pnpm add @cyc-seattle/calendar-sync
```

## Authentication

This package uses Google Application Default Credentials (ADC). Before using, authenticate with:

```bash
gcloud auth application-default login
```

## CLI Usage

### Basic Sync

```bash
calendar-sync \
  --spreadsheet-id "1abc..." \
  --events-worksheet "Events" \
  --calendars-worksheet "Calendars"
```

### With Verbose Logging

```bash
# Info level
calendar-sync --spreadsheet-id "1abc..." -v

# Debug level
calendar-sync --spreadsheet-id "1abc..." -vv
```

### Options

- `--spreadsheet-id <id>` - Google Spreadsheet ID or URL (required)
- `--events-worksheet <name>` - Events worksheet name (default: "Events")
- `--calendars-worksheet <name>` - Calendars worksheet name (default: "Calendars")
- `--logging <format>` - Logging format: `pretty` or `json` (default: `pretty`)
- `-v, --verbose` - Increase log level (can be repeated: `-v` for info, `-vv` for debug)

## Library Usage

```typescript
import { google } from "googleapis";
import { CalendarSyncClient } from "@cyc-seattle/calendar-sync";

// Initialize Google Auth
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/spreadsheets"],
});

// Create client
const client = new CalendarSyncClient(
  auth,
  "spreadsheet-id",
  "Calendars", // calendars worksheet name
  "Events", // events worksheet name
);

// Initialize and sync
const sync = await client.initialize();
const result = await sync.sync();

console.log(`Created: ${result.created}, Updated: ${result.updated}`);
```

## Spreadsheet Format

The spreadsheet requires two worksheets:

### Calendars Worksheet

Maps calendar names to their Google Calendar IDs:

| Name     | ID                                    |
| -------- | ------------------------------------- |
| Team     | team@group.calendar.google.com        |
| Personal | c_abc123...@group.calendar.google.com |

### Events Worksheet

Contains events to sync to calendars:

| Event ID | Start Date | End Date  | Calendar | Labels  | Title            | Location | Description    |
| -------- | ---------- | --------- | -------- | ------- | ---------------- | -------- | -------------- |
| abc123   | 2/16/2026  | 2/20/2026 | Team     | SPS     | Mid Winter Break | Seattle  | School break   |
|          | 3/15/2026  | 3/15/2026 | Personal | Meeting | Team Sync        | Office   | Weekly meeting |
|          |            |           | Team     | Camp    | Summer Camp      |          | TBD            |

#### Column Descriptions

- `Event ID` - Auto-populated by Google Calendar after creation. Leave blank for new events.
- `Start Date` - Event start date in M/d/yyyy format (e.g., "2/16/2026")
- `End Date` - Event end date in M/d/yyyy format. If blank, uses Start Date.
- `Calendar` - Calendar name from the Calendars worksheet
- `Labels` - Comma-separated labels to prepend to title (e.g., "SPS, Camp" → "[SPS] [Camp] Title")
- `Title` - Event title/summary
- `Location` - Event location (optional)
- `Description` - Event description (optional)

#### Special Behaviors

- **Tentative Events**: Rows with blank `Start Date` are skipped (useful for planning future events)
- **New Events**: Rows with blank `Event ID` will create new calendar events and populate the ID
- **Updates**: Rows with existing `Event ID` will update the corresponding calendar event
- **All-Day Events**: All events are currently created as all-day events

## How It Works

1. Loads the Calendars worksheet to get calendar name → ID mappings
2. Loads the Events worksheet to get all events to sync
3. For each event with a Start Date:
   - Looks up the calendar by name
   - If Event ID is blank: creates new event and saves the generated ID back to the spreadsheet
   - If Event ID exists: checks if event exists in calendar
     - If exists: updates the event
     - If not exists: creates the event with the provided ID
4. Skips events with blank Start Date (tentative events)
5. Returns count of created and updated events

## API Rate Limits

This package uses the `@cyc-seattle/gsuite` package which automatically throttles requests to respect Google's API quotas with exponential backoff retry.

## Development

```bash
# Build the package
pnpm run build

# Clean build artifacts
pnpm run clean
```

## License

Apache-2.0
