import { Option } from '@commander-js/extra-typings';

export class TodoistTokenOption extends Option<
  '-t, --token <token>',
  undefined,
  undefined,
  undefined,
  true,
  undefined
> {
  constructor() {
    super('-t, --token <token>');
    this.env('TODOIST_API_TOKEN');
  }
}
