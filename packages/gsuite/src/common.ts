import winston from "winston";
import { backOff } from "exponential-backoff";
import { setTimeout } from "timers/promises";

// The default quota on Google Spreadsheet API is 60 requests/minute/user.
// However, there's a separate read and write quota, so we can safely double
// this to get a little bit more throughput.
const requestPerMinute = 60 * 2;
const millisPerRequest = (60 * 1000) / requestPerMinute;

/**
 * Extracts the HTTP status code from an error thrown by a Google API client.
 *
 * The two client libraries in use report the status differently:
 * - `google-spreadsheet` uses axios, which exposes it as `error.response.status`.
 * - `googleapis` uses gaxios, which additionally sets a numeric `error.code`
 *   (and `error.status` on newer versions).
 *
 * Returns `undefined` when no HTTP status can be determined (e.g. a plain
 * programming error or a network failure without a response).
 */
export function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown } | null;
  };

  const response = candidate.response;
  if (response && typeof response.status === "number") {
    return response.status;
  }

  if (typeof candidate.status === "number") {
    return candidate.status;
  }

  // gaxios sets `code` to the numeric HTTP status (older versions may set it to
  // a string like "ERR_BAD_REQUEST", which we ignore here).
  if (typeof candidate.code === "number") {
    return candidate.code;
  }

  return undefined;
}

/**
 * Decides whether a failed Google API request should be retried.
 *
 * Only transient conditions are retryable:
 * - HTTP 429 (rate limited)
 * - HTTP 5xx (server errors)
 *
 * Everything else — most notably 4xx client errors like 401/403 (auth /
 * permission) and 404 (not found) — is a hard failure that will never succeed
 * on retry, so we fail fast instead of waiting out the backoff delay.
 *
 * Errors with no discernible HTTP status (e.g. network errors) are treated as
 * transient and retried, since those are frequently recoverable.
 */
export function isRetryableError(error: unknown): boolean {
  const status = getHttpStatus(error);

  if (status === undefined) {
    return true;
  }

  if (status === 429) {
    return true;
  }

  return status >= 500 && status <= 599;
}

/**
 * Rate-limited wrapper for Google API calls with exponential backoff retry.
 *
 * Retries only transient failures (see {@link isRetryableError}); non-retryable
 * errors are re-thrown immediately rather than incurring the backoff delay.
 */
export async function safeCall<T>(request: () => Promise<T>): Promise<T> {
  await setTimeout(millisPerRequest);
  return backOff(request, {
    jitter: "full",
    numOfAttempts: 2,
    startingDelay: 60_000,
    retry: (error: unknown) => {
      if (!isRetryableError(error)) {
        return false;
      }
      winston.warn("Transient error from Google API. Retrying", {
        status: getHttpStatus(error),
      });
      return true;
    },
  });
}
