import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getHttpStatus, isRetryableError, safeCall } from "../src/common.js";

// Mimic the error shapes thrown by the two Google client libraries.
// google-spreadsheet (axios): status lives on `error.response.status`.
function axiosError(status: number) {
  return { response: { status }, message: `Request failed with status ${status}` };
}
// googleapis (gaxios): numeric HTTP status on `error.code`, no response object.
function gaxiosError(status: number) {
  return { code: status, message: `gaxios error ${status}` };
}

describe("getHttpStatus", () => {
  it("reads status from an axios-style response", () => {
    expect(getHttpStatus(axiosError(404))).toBe(404);
  });

  it("reads status from a gaxios-style numeric code", () => {
    expect(getHttpStatus(gaxiosError(429))).toBe(429);
  });

  it("prefers response.status over code when both present", () => {
    expect(getHttpStatus({ code: 500, response: { status: 403 } })).toBe(403);
  });

  it("reads a top-level numeric status", () => {
    expect(getHttpStatus({ status: 503 })).toBe(503);
  });

  it("ignores non-numeric gaxios codes", () => {
    expect(getHttpStatus({ code: "ERR_BAD_REQUEST" })).toBeUndefined();
  });

  it("returns undefined for plain and non-object errors", () => {
    expect(getHttpStatus(new Error("boom"))).toBeUndefined();
    expect(getHttpStatus("nope")).toBeUndefined();
    expect(getHttpStatus(null)).toBeUndefined();
  });
});

describe("isRetryableError", () => {
  it("retries HTTP 429 (rate limited)", () => {
    expect(isRetryableError(axiosError(429))).toBe(true);
    expect(isRetryableError(gaxiosError(429))).toBe(true);
  });

  it.each([500, 502, 503, 599])("retries HTTP %i (server error)", (status) => {
    expect(isRetryableError(axiosError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])("does not retry HTTP %i (client error)", (status) => {
    expect(isRetryableError(axiosError(status))).toBe(false);
    expect(isRetryableError(gaxiosError(status))).toBe(false);
  });

  it("retries when no HTTP status is present (e.g. network error)", () => {
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
  });
});

describe("safeCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the resolved value on success", async () => {
    const request = vi.fn().mockResolvedValue("ok");
    const promise = safeCall(request);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails fast on a non-retryable error without retrying", async () => {
    const request = vi.fn().mockRejectedValue(axiosError(404));
    const promise = safeCall(request);
    // Attach a rejection handler up front so the run doesn't see it as unhandled.
    const assertion = expect(promise).rejects.toMatchObject({ response: { status: 404 } });
    await vi.runAllTimersAsync();
    await assertion;
    // Only the initial attempt — no retry.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a transient error and can eventually succeed", async () => {
    const request = vi.fn().mockRejectedValueOnce(axiosError(503)).mockResolvedValueOnce("recovered");
    const promise = safeCall(request);
    // Drain the rate-limit delay and the backoff delay between attempts.
    // exponential-backoff schedules its retry timer only after the first
    // attempt rejects, so advance repeatedly until both calls have happened.
    while (request.mock.calls.length < 2) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
