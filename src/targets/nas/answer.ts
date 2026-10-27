// The NAS verbs' answer grammar (CRB-b128 §1.2) and one decoder per verb (§2.2). An answer is tab-separated rows, with free
// text JSON-encoded on one line, ending in exactly one line `__OUP_RC=<n>`. Parsing fails closed: an answer over its verb's
// cap, a marker line that is not the final line, a malformed marker, a control character, an empty row, a row the verb
// does not define or a field outside its rule is an error. A missing marker is rc undefined, which callers read as unknown.

import { SLOT } from "./verbs.ts";

export interface Row {
  tag: string;
  fields: string[];
}
export type Parsed = { ok: true; rows: Row[]; rc: number | undefined } | { ok: false; why: string };
export type Decoded<T> = { ok: true; value: T } | { ok: false; why: string };

const MARK = "__OUP_RC=";
const RC_LINE = /^__OUP_RC=(\d{1,3})$/;
/** Control characters other than tab (a row's separator); newline cannot occur inside a line. */
const LINE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/** Any control character, for decoded JSON text that must stay on one line. */
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;

export function parseAnswer(text: string, capBytes: number): Parsed {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > capBytes) return { ok: false, why: `answer is ${bytes} bytes, over the ${capBytes}-byte cap` };
  if (text === "") return { ok: true, rows: [], rc: undefined };
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const last = lines[lines.length - 1]!;
  const m = RC_LINE.exec(last);
  if (!m && last.startsWith(MARK)) return { ok: false, why: `malformed marker line ${JSON.stringify(last.slice(0, 40))}` };
  const body = m ? lines.slice(0, -1) : lines;
  const rows: Row[] = [];
  for (const [i, l] of body.entries()) {
    if (l.startsWith(MARK)) return { ok: false, why: `line ${i + 1}: a marker line that is not the final line` };
    if (LINE_CONTROL.test(l)) return { ok: false, why: `line ${i + 1}: a control character` };
    if (l === "") return { ok: false, why: `line ${i + 1}: an empty row` };
    const [tag, ...fields] = l.split("\t");
    rows.push({ tag: tag!, fields });
  }
  return { ok: true, rows, rc: m ? Number(m[1]) : undefined };
}

const SHA = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;
const SCRIPT = /^[A-Za-z0-9._-]{1,64}$/;
const PATH = /^\/[A-Za-z0-9/._-]{0,200}$/;
const COUNT = /^\d{1,4}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_SERVICES = 15;

const fail = (why: string): { ok: false; why: string } => ({ ok: false, why });
const badRow = (verb: string, i: number, r: Row) => fail(`${verb} row ${i + 1} (${r.tag}) is not valid`);

function jsonString(f: string | undefined): string | undefined {
  try {
    const v: unknown = JSON.parse(f ?? "");
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A docker `{{json .Config.Entrypoint}}` or `.Cmd`: null or an array of strings, re-encoded in one canonical JSON form. */
export function jsonArgv(f: string | undefined): string | undefined {
  try {
    const v: unknown = JSON.parse(f ?? "");
    return v === null || (Array.isArray(v) && v.every((x) => typeof x === "string")) ? JSON.stringify(v) : undefined;
  } catch {
    return undefined;
  }
}

export interface SelfInfo {
  scripts: { name: string; ram: string; flash: string }[];
  unraid: string;
  sh: string;
  plugins: string;
}

export function decodeSelf(rows: Row[]): Decoded<SelfInfo> {
  const scripts: SelfInfo["scripts"] = [];
  let unraid: string | undefined;
  let sh: string | undefined;
  let plugins: string | undefined;
  for (const [i, r] of rows.entries()) {
    const f = r.fields;
    if (r.tag === "SCRIPT" && f.length === 3 && SCRIPT.test(f[0]!) && SHA.test(f[1]!) && SHA.test(f[2]!)) scripts.push({ name: f[0]!, ram: f[1]!, flash: f[2]! });
    else if (r.tag === "UNRAID" && f.length === 1 && unraid === undefined && VERSION.test(f[0]!)) unraid = f[0];
    else if (r.tag === "SH" && f.length === 1 && sh === undefined && PATH.test(f[0]!)) sh = f[0];
    else if (r.tag === "PLUGINS" && f.length === 1 && plugins === undefined && SHA.test(f[0]!)) plugins = f[0];
    else return badRow("self", i, r);
  }
  if (scripts.length !== 2 || !unraid || !sh || !plugins) return fail("self: needs two SCRIPT rows and one UNRAID, SH and PLUGINS row");
  return { ok: true, value: { scripts, unraid, sh, plugins } };
}

export interface ComposeService {
  service: string;
  ref: string;
  localId: string;
  /** Absent when the service has no running container ("-"). */
  runningId?: string;
}
export interface ComposeState {
  /** The interpolated config's sha256, then each env file's (only hashes leave the NAS). */
  config: string[];
  services: ComposeService[];
  /** Buildable services: reported, never reviewed. */
  build: string[];
}

export function decodeComposeState(rows: Row[]): Decoded<ComposeState> {
  let config: string[] | undefined;
  const services: ComposeService[] = [];
  const build: string[] = [];
  for (const [i, r] of rows.entries()) {
    const f = r.fields;
    if (r.tag === "CONFIG" && config === undefined && f.length >= 1 && f.every((x) => SHA.test(x))) config = [...f];
    else if (r.tag === "SVC" && f.length === 4 && SLOT.service.test(f[0]!) && SLOT.ref.test(f[1]!) && SLOT.id.test(f[2]!) && (f[3] === "-" || SLOT.id.test(f[3]!))) {
      if (services.some((x) => x.service === f[0])) return fail(`compose.state: service ${f[0]} is listed twice`);
      services.push({ service: f[0]!, ref: f[1]!, localId: f[2]!, ...(f[3] === "-" ? {} : { runningId: f[3]! }) });
    } else if (r.tag === "BUILD" && f.length === 1 && SLOT.service.test(f[0]!)) build.push(f[0]!);
    else return badRow("compose.state", i, r);
  }
  if (!config) return fail("compose.state: no CONFIG row");
  if (services.length > MAX_SERVICES) return fail(`compose.state: more than ${MAX_SERVICES} services`);
  return { ok: true, value: { config, services, build } };
}

export interface ImageEvidence {
  id?: string;
  /** image.candidate: the linux/amd64 platform manifest digest. */
  digest?: string;
  /** image.candidate: the config digest. */
  config?: string;
  /** Canonical JSON of Config.Entrypoint (null or a string array). */
  entrypoint: string;
  cmd: string;
  /** Each history entry's created_by, decoded, in the order the NAS sent them. */
  history: string[];
}

type One = "ID" | "DIGEST" | "CONFIG" | "ENTRYPOINT" | "CMD";

export function decodeEvidence(verb: "image.evidence" | "image.candidate", rows: Row[]): Decoded<ImageEvidence> {
  const allowed: One[] = verb === "image.candidate" ? ["DIGEST", "CONFIG", "ID", "ENTRYPOINT", "CMD"] : ["ID", "ENTRYPOINT", "CMD"];
  const one: Partial<Record<One, string>> = {};
  const history: string[] = [];
  for (const [i, r] of rows.entries()) {
    const f = r.fields;
    if (r.tag === "HIST") {
      const h = f.length === 1 ? jsonString(f[0]) : undefined;
      if (h === undefined) return badRow(verb, i, r);
      history.push(h);
      continue;
    }
    if (!(allowed as string[]).includes(r.tag) || f.length !== 1) return badRow(verb, i, r);
    const tag = r.tag as One;
    if (one[tag] !== undefined) return badRow(verb, i, r);
    const v = tag === "ENTRYPOINT" || tag === "CMD" ? jsonArgv(f[0]) : SLOT.id.test(f[0]!) ? f[0] : undefined;
    if (v === undefined) return badRow(verb, i, r);
    one[tag] = v;
  }
  const need = (verb === "image.candidate" ? (["DIGEST", "CONFIG", "ENTRYPOINT", "CMD"] as One[]) : (["ID", "ENTRYPOINT", "CMD"] as One[])).filter((k) => one[k] === undefined);
  if (need.length) return fail(`${verb}: needs ${need.join(", ")}`);
  return {
    ok: true,
    value: { ...(one.ID ? { id: one.ID } : {}), ...(one.DIGEST ? { digest: one.DIGEST } : {}), ...(one.CONFIG ? { config: one.CONFIG } : {}), entrypoint: one.ENTRYPOINT!, cmd: one.CMD!, history },
  };
}

export interface PluginRow {
  name: string;
  installed: string;
  candidate: string;
  installedSha: string;
  copySha: string;
  /** The private copy's mktemp suffix on the NAS. */
  copy: string;
}
export interface PluginCheck {
  plugins: PluginRow[];
  /** .plg files whose name is outside the plugin rule; the NAS skipped them. */
  skipped: number;
}

export function decodePluginCheck(rows: Row[]): Decoded<PluginCheck> {
  const plugins: PluginRow[] = [];
  let skipped: number | undefined;
  for (const [i, r] of rows.entries()) {
    const f = r.fields;
    if (r.tag === "PLG" && f.length === 6) {
      const name = jsonString(f[0]);
      const installed = jsonString(f[1]);
      const candidate = jsonString(f[2]);
      if (
        name !== undefined && SLOT.plugin.test(name) && !plugins.some((p) => p.name === name) &&
        installed !== undefined && candidate !== undefined && installed.length <= 64 && candidate.length <= 64 && !ANY_CONTROL.test(installed + candidate) &&
        SHA.test(f[3]!) && SHA.test(f[4]!) && SLOT.copy.test(f[5]!)
      ) {
        plugins.push({ name, installed, candidate, installedSha: f[3]!, copySha: f[4]!, copy: f[5]! });
        continue;
      }
    } else if (r.tag === "SKIP" && f.length === 1 && skipped === undefined && COUNT.test(f[0]!)) {
      skipped = Number(f[0]);
      continue;
    }
    return badRow("plugin.check", i, r);
  }
  return { ok: true, value: { plugins, skipped: skipped ?? 0 } };
}

export function decodePluginFile(rows: Row[]): Decoded<Uint8Array> {
  const r = rows[0];
  if (rows.length !== 1 || !r || r.tag !== "B64" || r.fields.length !== 1 || !B64.test(r.fields[0]!)) return fail("plugin.file: needs exactly one B64 row");
  return { ok: true, value: new Uint8Array(Buffer.from(r.fields[0]!, "base64")) };
}

export function decodeOsVersion(rows: Row[]): Decoded<string> {
  const r = rows[0];
  if (rows.length !== 1 || !r || r.tag !== "UNRAID" || r.fields.length !== 1 || !VERSION.test(r.fields[0]!)) return fail("os.version: needs exactly one UNRAID row");
  return { ok: true, value: r.fields[0]! };
}
