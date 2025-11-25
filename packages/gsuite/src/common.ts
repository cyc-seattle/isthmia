import winston from "winston";
import { backOff } from "exponential-backoff";
import { setTimeout } from "timers/promises";

// The default quota on Google Spreadsheet API is 60 requests/minute/user.
// However, there's a separate read and write quota, so we can safely double
// this to get a little bit more throughput.
const requestPerMinute = 60 * 2;
const millisPerRequest = (60 * 1000) / requestPerMinute;

/**
 * Rate-limited wrapper for Google API calls with exponential backoff retry
 */
export async function safeCall<T>(request: () => Promise<T>): Promise<T> {
  await setTimeout(millisPerRequest);
  return backOff(request, {
    jitter: "full",
    numOfAttempts: 2,
    startingDelay: 60_000,
    retry: () => {
      winston.warn("Request to Google API failed. Retrying");
      return true;
    },
  });
}
