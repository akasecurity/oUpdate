import type { Signal } from "./prepass.ts";

/** What a registry says about who published one version, and how. */
export interface PublisherFacts {
  publishedAt?: Date;
  /** Account names on the package's maintainer list when this version was published. */
  maintainers: string[];
  /** The account that published this version. */
  publisher?: string;
  /** A build-provenance attestation is attached to the version. */
  provenance: boolean;
  /** The registry signed the version's tarball. */
  signed: boolean;
  /** Published by a trusted-publishing workflow; the registry then names the workflow runner, not a person, as publisher. */
  trusted: boolean;
}

export interface VersionPublisher {
  facts: PublisherFacts;
  /** Publish time of the newest other version published before this one. */
  previousPublishedAt?: Date;
}

export const PUBLISH_GAP_DAYS = 180;

/** Where a registry signal points: it is no file of the release. */
export const REGISTRY_PATH = "registry";
const KINDS = new Set(["provenance-dropped", "signature-dropped", "trusted-publishing-dropped", "new-publisher", "new-maintainer", "publish-gap"]);
/** True for a signal built here. A release file that happens to be named "registry" never has one of these kinds. */
export const isRegistrySignal = (s: { kind: string; path: string }): boolean => s.path === REGISTRY_PATH && KINDS.has(s.kind);

/**
 * Soft signals about who published a release, from registry metadata. oUpdate judges the content of a
 * release; these only tell the reviewer that the publisher side changed. None is a hold on its own. The gap needs no
 * previous version's facts here, but the review asks for these signals only on an update (it has a `from` version), so
 * a first install gets none.
 */
export function publisherSignals(from: PublisherFacts | undefined, to: VersionPublisher): Signal[] {
  const out: Signal[] = [];
  const push = (kind: string, detail: string) => out.push({ kind, path: REGISTRY_PATH, detail });
  const { facts, previousPublishedAt } = to;
  if (from) {
    if (from.provenance && !facts.provenance) push("provenance-dropped", "the previous version has a build-provenance attestation and this one has none");
    if (from.signed && !facts.signed) push("signature-dropped", "the previous version has a registry signature and this one has none");
    if (from.trusted && !facts.trusted) push("trusted-publishing-dropped", "the previous version was published by a trusted-publishing workflow and this one was not");
    else if (!(facts.trusted && !from.trusted) && from.publisher && facts.publisher && from.publisher !== facts.publisher) push("new-publisher", `published by ${facts.publisher.slice(0, 80)}; the previous version was published by ${from.publisher.slice(0, 80)}`);
    const known = new Set(from.maintainers);
    const added = from.maintainers.length ? facts.maintainers.filter((m) => !known.has(m)) : [];
    if (added.length) push("new-maintainer", `maintainer(s) not on the previous version: ${added.slice(0, 5).join(", ").slice(0, 160)}`);
  }
  if (facts.publishedAt && previousPublishedAt) {
    const days = Math.floor((facts.publishedAt.getTime() - previousPublishedAt.getTime()) / 86_400_000);
    if (days > PUBLISH_GAP_DAYS) push("publish-gap", `first publish in ${days} days (limit ${PUBLISH_GAP_DAYS})`);
  }
  return out;
}

