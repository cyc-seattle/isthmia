import * as functions from '@google-cloud/functions-framework';

function helloWorld(_request: functions.Request, response: functions.Response) {
  response.send('OK');
}

functions.http('HelloWorld', helloWorld);
