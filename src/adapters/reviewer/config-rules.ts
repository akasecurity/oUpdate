// Rules on reviewer config text that is printed as written: in review details, in the verdict store, in logs. Checked when a
// spec is read and again when a reviewer is built, so a programmatic caller gets the same config error.

/** A reviewer name is plain text: no URL, credential, query or fragment can ride in it. */
export function checkReviewerName(name: string): void {
  if (/:\/\/|[@?#\s]/.test(name)) throw new Error('reviewer name must be plain text: no "://", "@", "?", "#" or whitespace');
}

// An HTTP header name is an RFC 9110 token: a name with a space or a colon would make every answer fail when it is read.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The served-by header name, when set, is a legal header name. */
export function checkServedByHeader(name: unknown): void {
  if (name !== undefined && (typeof name !== "string" || !HEADER_NAME.test(name)))
    throw new Error("openai reviewer servedByHeader must be a legal HTTP header name (letters, digits and !#$%&'*+-.^_`|~)");
}

/** expectHeaders names are read with headers.get, which throws on an illegal name and quotes it: refused here without quoting it. */
export function checkExpectHeaders(expect: Record<string, string> | undefined): void {
  if (expect && !Object.keys(expect).every((n) => HEADER_NAME.test(n)))
    throw new Error("openai reviewer expectHeaders names must be legal HTTP header names (letters, digits and !#$%&'*+-.^_`|~)");
}

// Plain http is only safe for a credential when the request never leaves the machine.
const LOOPBACK = new Set(["localhost", "[::1]"]);
export function loopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/**
 * A base URL whose credentials could be read two ways is refused: an @ the parser did not take as the end of a userinfo
 * (user alice with the password 123?ss parses as host alice, port 123, and a query holding the rest), so whatever prints
 * the parsed URL would print part of a password. The parser ends the host at / or \ too, so alice:123/ss@host sends the
 * request to host alice with part of the password in the path. The parser leaves every @ outside a userinfo as written,
 * so a raw @ in the parsed path, query or fragment is refused. The raw text is checked too, because dot segments (/../,
 * %2e%2e, \..\) can drop the path part that held the @: after the scheme, no @ may follow the first / \ ? or #, and the
 * authority holds at most one (with two, this parser ends the userinfo at the last and another reader at the first). An @
 * meant for a path or a credential must be written %40. The error names the base by its place in the list, never its
 * text. A base the parser refuses outright is left to fail when it is tried.
 * Known limit: a password whose @ separator was itself percent-encoded (alice:123/ss%40host/x) has no raw @ left, so it
 * parses as host alice, port 123, and passes; nothing in the text can tell it from a real %40 in a path. An error shows
 * such a base only by its place in the list (shownBase prints no path holding %40).
 * A userinfo over plain http to a host off the machine is refused too: fetch sends it as an Authorization: Basic header.
 */
export function checkBaseUrl(base: string, i: number): void {
  const raw = base.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  const rest = raw.replace(/^[A-Za-z][A-Za-z0-9+.-]*:[/\\]*/, "");
  const end = rest.search(/[/\\?#]/);
  const rawTail = end >= 0 && rest.slice(end).includes("@");
  // A second raw @ in the authority: this parser ends the userinfo at the last @, another reader at the first, so the host
  // a reader sees may not be the one the request goes to.
  const rawUserinfo = (end >= 0 ? rest.slice(0, end) : rest).split("@").length > 2;
  if (rawTail || rawUserinfo || [u.pathname, u.search, u.hash].some((part) => part.includes("@")))
    throw new Error(`base #${i + 1} is ambiguous: percent-encode @ ? # in credentials, and @ in a path as %40`);
  if (u.protocol === "http:" && (u.username || u.password) && !loopbackHost(u.hostname))
    throw new Error(`base #${i + 1} has a userinfo over plain http to a non-loopback host: use https`);
}
