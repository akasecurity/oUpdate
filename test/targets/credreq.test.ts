// The credreq door every broker reach shares: argv only, the verb first, then each param; the broker's base URL in env;
// any reply that is not a broker outcome is no reply, with the reason.
import { describe, expect, test } from "bun:test";
import { credreqCall, requestLine } from "../../src/targets/credreq.ts";
import { fakeExec } from "./fakes.ts";

const DOOR = { credreq: "/opt/credreq", baseUrl: "https://broker.example.invalid" };
const answering = (res: { rc?: number; out?: string; err?: string; timedOut?: boolean }) => fakeExec([(argv) => (argv[0] === "/opt/credreq" ? res : undefined)]);

describe("credreqCall", () => {
  test("argv only: action, target, why, wait, the verb, then each param; the base URL in env", async () => {
    const { exec, calls } = answering({ out: `${JSON.stringify({ status: "approved", request_id: "req-1", result: { a: 1 } })}\n` });
    const r = await credreqCall(DOOR, exec, "cloud.osc.read", "vm-a", "inventory", [{ key: "run_id", value: "run-vm-a-0001" }, { key: "verdict", value: '{"x":1}', json: true }], 315);
    expect(r).toEqual({ ok: true, reply: { status: "approved", result: { a: 1 }, requestId: "req-1" }, raw: JSON.stringify({ status: "approved", request_id: "req-1", result: { a: 1 } }) });
    expect(calls[0]!.argv).toEqual(["/opt/credreq", "cloud.osc.read", "vm-a", "--why", "oupdate inventory", "--wait", "315", "--param", "verb=inventory", "--param", "run_id=run-vm-a-0001", "--param-json", 'verdict={"x":1}']);
    expect(calls[0]!.env).toEqual({ CREDBROKER_BASE_URL: "https://broker.example.invalid" });
    expect(calls[0]!.timeoutMs).toBe(345_000);
  });

  test.each([
    ["a timeout", { timedOut: true, rc: 143 }, "credreq timed out after 40 s"],
    ["credreq missing", { rc: 127, err: "not found" }, "credreq did not start: not found"],
    ["a usage error", { rc: 2, err: "usage: x" }, "credreq usage error: usage: x"],
    ["no JSON", { rc: 1, out: "<html>", err: "proxy error" }, "credreq gave no outcome (rc 1: proxy error)"],
    ["an unknown status", { rc: 0, out: '{"status":"maybe"}' }, "credreq gave no outcome (rc 0)"],
  ] as const)("%s is no reply, with the reason", async (_what, res, why) => {
    const { exec } = answering(res);
    expect(await credreqCall(DOOR, exec, "a.read", "t", "v", [], 10)).toEqual({ ok: false, why });
  });

  test("a request id outside its rule is dropped", async () => {
    const { exec } = answering({ out: JSON.stringify({ status: "denied", request_id: "bad id!" }) });
    expect(await credreqCall(DOOR, exec, "a.read", "t", "v", [], 10)).toEqual({ ok: true, reply: { status: "denied", result: undefined }, raw: JSON.stringify({ status: "denied", request_id: "bad id!" }) });
  });

  test("requestLine names the broker's request id when there is one", () => {
    expect(requestLine({ why: "patch: job started" })).toBe("patch: job started");
    expect(requestLine({ why: "patch: job started", requestId: "req-7" })).toBe("patch: job started [broker request req-7]");
  });
});
