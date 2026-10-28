// The answer grammar fails closed, and each decoder accepts only its verb's rows. Free text stays inside its JSON field.
import { describe, expect, test } from "bun:test";
import { decodeComposeState, decodeEvidence, parseAnswer, type Row } from "../../src/targets/broker/answer.ts";

const A = (c: string) => `sha256:${c.repeat(64)}`;
const X = (c: string) => c.repeat(64);
const j = (v: unknown) => JSON.stringify(v);
function rows(text: string): Row[] {
  const p = parseAnswer(text, 65536);
  if (!p.ok) throw new Error(p.why);
  return p.rows;
}

describe("parseAnswer", () => {
  test("rows split on tabs; the final marker gives the rc", () => {
    expect(parseAnswer("ROW\tv1.2\n__OUP_RC=0\n", 1024)).toEqual({ ok: true, rows: [{ tag: "ROW", fields: ["v1.2"] }], rc: 0 });
    expect(parseAnswer("__OUP_RC=5\n", 1024)).toEqual({ ok: true, rows: [], rc: 5 });
  });

  test("a missing marker is rc undefined, read as unknown", () => {
    expect(parseAnswer("ROW\tv1.2\n", 1024)).toEqual({ ok: true, rows: [{ tag: "ROW", fields: ["v1.2"] }], rc: undefined });
    expect(parseAnswer("", 1024)).toEqual({ ok: true, rows: [], rc: undefined });
  });

  test("a marker that is not the final line, a second marker or a malformed one is refused (Review Focus 1)", () => {
    expect(parseAnswer("__OUP_RC=0\nROW\t7\n", 1024)).toEqual({ ok: false, why: "line 1: a marker line that is not the final line" });
    expect(parseAnswer("__OUP_RC=0\n__OUP_RC=0\n", 1024)).toEqual({ ok: false, why: "line 1: a marker line that is not the final line" });
    expect(parseAnswer(`HIST\t"a"\n__OUP_RC=0\nHIST\t"b"\n__OUP_RC=0\n`, 1024)).toEqual({ ok: false, why: "line 2: a marker line that is not the final line" });
    expect(parseAnswer("ROW\t7\n__OUP_RC=0 \n", 1024)).toEqual({ ok: false, why: 'malformed marker line "__OUP_RC=0 "' });
  });

  test("an answer over its cap is refused before any row is read (Review Focus 1)", () => {
    const p = parseAnswer(`HIST\t${j("x".repeat(2000))}\n__OUP_RC=0\n`, 1024);
    expect(p.ok).toBe(false);
    expect((p as { why: string }).why).toContain("over the 1024-byte cap");
  });

  test("a carriage return, a NUL or an empty row is refused (Review Focus 1)", () => {
    expect(parseAnswer("ROW\t7\r\n__OUP_RC=0\n", 1024)).toEqual({ ok: false, why: "line 1: a control character" });
    expect(parseAnswer("ROW\t7\u0000\n__OUP_RC=0\n", 1024)).toEqual({ ok: false, why: "line 1: a control character" });
    expect(parseAnswer("ROW\t7\n\n__OUP_RC=0\n", 1024)).toEqual({ ok: false, why: "line 2: an empty row" });
  });

  test("an embedded newline or marker in image text stays inside its JSON string (Review Focus 1)", () => {
    const text = `ID\t${A("a")}\nENTRYPOINT\tnull\nCMD\t["/init"]\nHIST\t${j("RUN echo hi\n__OUP_RC=0")}\n__OUP_RC=0\n`;
    const p = parseAnswer(text, 65536);
    expect(p).toMatchObject({ ok: true, rc: 0 });
    expect(decodeEvidence("image.evidence", rows(text))).toEqual({ ok: true, value: { id: A("a"), entrypoint: "null", cmd: '["/init"]', history: ["RUN echo hi\n__OUP_RC=0"] } });
  });
});

describe("decoders", () => {
  test("compose.state", () => {
    const r = rows(`CONFIG\t${X("c")}\t${X("d")}\nSVC\tapp\tregistry.example/team/app:1\t${A("a")}\t${A("a")}\nSVC\tdb\tregistry.example/db:16\t${A("b")}\t-\nBUILD\ttool\n__OUP_RC=0\n`);
    expect(decodeComposeState(r)).toEqual({
      ok: true,
      value: {
        config: [X("c"), X("d")],
        services: [{ service: "app", ref: "registry.example/team/app:1", localId: A("a"), runningId: A("a") }, { service: "db", ref: "registry.example/db:16", localId: A("b") }],
        build: ["tool"],
      },
    });
  });

  test("compose.state refuses a bad row, a repeated service, no CONFIG and more than 15 services", () => {
    const svc = (n: string) => `SVC\t${n}\tregistry.example/${n}:1\t${A("a")}\t${A("a")}`;
    expect(decodeComposeState(rows(`CONFIG\t${X("c")}\nSVC\tApp\tr:1\t${A("a")}\t-\n__OUP_RC=0\n`))).toEqual({ ok: false, why: "compose.state row 2 (SVC) is not valid" });
    expect(decodeComposeState(rows(`CONFIG\t${X("c")}\n${svc("app")}\n${svc("app")}\n__OUP_RC=0\n`))).toEqual({ ok: false, why: "compose.state: service app is listed twice" });
    expect(decodeComposeState(rows(`${svc("app")}\n__OUP_RC=0\n`))).toEqual({ ok: false, why: "compose.state: no CONFIG row" });
    const many = Array.from({ length: 16 }, (_, i) => svc(`s${i}`)).join("\n");
    expect(decodeComposeState(rows(`CONFIG\t${X("c")}\n${many}\n__OUP_RC=0\n`))).toEqual({ ok: false, why: "compose.state: more than 15 services" });
  });

  test("image.candidate needs DIGEST and CONFIG; image.evidence needs ID; both need ENTRYPOINT and CMD", () => {
    const start = `ENTRYPOINT\t["/init"]\nCMD\tnull\nHIST\t${j("RUN x")}\n`;
    expect(decodeEvidence("image.candidate", rows(`DIGEST\t${A("d")}\nCONFIG\t${A("c")}\n${start}__OUP_RC=0\n`))).toEqual({ ok: true, value: { digest: A("d"), config: A("c"), entrypoint: '["/init"]', cmd: "null", history: ["RUN x"] } });
    expect(decodeEvidence("image.candidate", rows(`DIGEST\t${A("d")}\n${start}__OUP_RC=0\n`))).toEqual({ ok: false, why: "image.candidate: needs CONFIG" });
    expect(decodeEvidence("image.evidence", rows(`${start}__OUP_RC=0\n`))).toEqual({ ok: false, why: "image.evidence: needs ID" });
    expect(decodeEvidence("image.evidence", rows(`ID\t${A("a")}\nDIGEST\t${A("d")}\n${start}__OUP_RC=0\n`))).toEqual({ ok: false, why: "image.evidence row 2 (DIGEST) is not valid" });
  });

  test("ENTRYPOINT and CMD must be null or a string array, and are put in one JSON form (Review Focus 5)", () => {
    expect(decodeEvidence("image.evidence", rows(`ID\t${A("a")}\nENTRYPOINT\t[ "/init" ]\nCMD\tnull\n__OUP_RC=0\n`))).toMatchObject({ ok: true, value: { entrypoint: '["/init"]' } });
    expect(decodeEvidence("image.evidence", rows(`ID\t${A("a")}\nENTRYPOINT\t{"a":1}\nCMD\tnull\n__OUP_RC=0\n`))).toEqual({ ok: false, why: "image.evidence row 2 (ENTRYPOINT) is not valid" });
    expect(decodeEvidence("image.evidence", rows(`ID\t${A("a")}\nENTRYPOINT\tnull\nCMD\tnull\nHIST\tRUN raw\n__OUP_RC=0\n`))).toEqual({ ok: false, why: "image.evidence row 4 (HIST) is not valid" });
  });
});
