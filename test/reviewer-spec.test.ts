import { describe, expect, test } from "bun:test";
import { parseReviewerSpec, validateReviewerSpec } from "../src/adapters/reviewer/spec.ts";

const openai = {
  type: "openai",
  name: "local",
  baseUrls: ["http://127.0.0.1:8080/v1"],
  model: "m",
  apiKeyEnv: "REVIEWER_API_KEY",
  maxTokens: 128,
  timeoutMs: 1000,
  extraBody: { temperature: 0 },
  headers: { "X-Key": "k" },
  expectHeaders: { "x-served-by": "local" },
  retryDelaysMs: [1, 2],
};

const command = {
  type: "command",
  name: "rev",
  argv: ["rev", "-p"],
  timeoutMs: 1000,
  workRoot: "/tmp/oupdate-review",
};

const OPENAI_VALID = "type, name, baseUrls, model, apiKeyEnv, maxTokens, timeoutMs, extraBody, headers, expectHeaders, retryDelaysMs";
const COMMAND_VALID = "type, name, argv, timeoutMs, workRoot";

const keysOf = (v: object) => Object.keys(v).sort();

describe("reviewer spec keys", () => {
  test("each openai key is accepted, including the rel-024 keys", () => {
    const got = validateReviewerSpec(openai);
    expect(got).toMatchObject(openai);
    expect(keysOf(got)).toEqual(keysOf(openai));
    for (const key of ["apiKeyEnv", "maxTokens", "timeoutMs", "extraBody", "headers", "expectHeaders", "retryDelaysMs"] as const) {
      const spec = { type: "openai", name: "local", baseUrls: ["http://127.0.0.1:8080/v1"], model: "m", [key]: openai[key] };
      expect(validateReviewerSpec(spec)).toMatchObject({ [key]: openai[key] });
    }
  });

  test("each command key is accepted", () => {
    const got = validateReviewerSpec(command);
    expect(got).toMatchObject(command);
    expect(keysOf(got)).toEqual(keysOf(command));
    expect(validateReviewerSpec({ type: "command", name: "rev", argv: ["rev"] })).toMatchObject({ name: "rev", argv: ["rev"] });
  });

  test("an unknown key is refused, and the error names the key, the block and the valid keys", () => {
    expect(() => validateReviewerSpec({ ...openai, expectHeader: "local" })).toThrow(
      `openai reviewer: unknown key expectHeader (valid keys: ${OPENAI_VALID})`,
    );
    expect(() => validateReviewerSpec({ ...openai, header: { "X-Key": "k" } })).toThrow(
      `openai reviewer: unknown key header (valid keys: ${OPENAI_VALID})`,
    );
    expect(() => parseReviewerSpec(JSON.stringify({ ...command, workroot: "/tmp" }))).toThrow(
      `command reviewer: unknown key workroot (valid keys: ${COMMAND_VALID})`,
    );
  });
});
