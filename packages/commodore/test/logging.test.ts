import { describe, it, expect } from "vitest";
import { InvalidOptionArgumentError } from "@commander-js/extra-typings";
import logform from "logform";
import { LoggingOption, OutputOption, VerboseOption } from "../src/logging.js";

// Commander invokes `option.parseArg(value, previous)` as a method call on the option, so the
// parser can read `this` off the receiver. Calling it detached from the option would not
// reproduce that. `parseArg` is typed optional and generic over `previous`'s type upstream, even
// though the constructor always sets a concrete one via `argParser` — hence the assertions below.
describe("VerboseOption", () => {
  it("increases from the default start level (warn) on the first call", () => {
    const option = new VerboseOption();
    expect(option.parseArg!("", undefined)).toBe("info");
  });

  it("increases from a custom start level on the first call", () => {
    const option = new VerboseOption("error");
    expect(option.parseArg!("", undefined)).toBe("warn");
  });

  it("increases again on a repeat call", () => {
    const option = new VerboseOption();
    expect(option.parseArg!("", "info")).toBe("debug");
  });

  it("saturates at debug rather than running off the end of the level list", () => {
    const option = new VerboseOption();
    expect(option.parseArg!("", "debug")).toBe("debug");
  });
});

describe("OutputOption", () => {
  it("maps a known format to its logform.Format", () => {
    const option = new OutputOption();
    const format = option.parseArg!("json", undefined) as unknown as logform.Format;
    expect(typeof format.transform).toBe("function");
  });

  it("throws for an unknown format, listing the valid choices", () => {
    const option = new OutputOption();
    expect(() => option.parseArg!("bogus", undefined)).toThrow(InvalidOptionArgumentError);
    expect(() => option.parseArg!("bogus", undefined)).toThrow("Must be one of: pretty, json");
  });
});

describe("LoggingOption", () => {
  it("maps a known format to its logform.Format", () => {
    const option = new LoggingOption();
    const format = option.parseArg!("pretty", undefined) as unknown as logform.Format;
    expect(typeof format.transform).toBe("function");
  });

  it("throws for an unknown format, listing the valid choices", () => {
    const option = new LoggingOption();
    expect(() => option.parseArg!("bogus", undefined)).toThrow(InvalidOptionArgumentError);
    expect(() => option.parseArg!("bogus", undefined)).toThrow("Must be one of: json, pretty");
  });
});
