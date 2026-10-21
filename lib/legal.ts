import type { MessageKey } from "@/lib/i18n/en";

export type LegalSection = {
  heading: MessageKey;
  paragraphs?: MessageKey[];
  items?: MessageKey[];
};

export const TERMS_SECTIONS: LegalSection[] = [
  { heading: "legal.terms.who.h", paragraphs: ["legal.terms.who.p1"] },
  { heading: "legal.terms.hosts.h", paragraphs: ["legal.terms.hosts.p1"] },
  { heading: "legal.terms.participants.h", paragraphs: ["legal.terms.participants.p1"] },
  { heading: "legal.terms.plans.h", paragraphs: ["legal.terms.plans.p1"] },
  { heading: "legal.terms.changes.h", paragraphs: ["legal.terms.changes.p1"] },
  { heading: "legal.terms.contact.h", paragraphs: ["legal.terms.contact.p1"] },
];

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: "legal.privacy.stored.h",
    paragraphs: ["legal.privacy.stored.p1"],
    items: ["legal.privacy.stored.i1", "legal.privacy.stored.i2", "legal.privacy.stored.i3", "legal.privacy.stored.i4"],
  },
  { heading: "legal.privacy.cookies.h", paragraphs: ["legal.privacy.cookies.p1"] },
  { heading: "legal.privacy.ai.h", paragraphs: ["legal.privacy.ai.p1", "legal.privacy.ai.p2"] },
  { heading: "legal.privacy.delete.h", paragraphs: ["legal.privacy.delete.p1"], items: ["legal.privacy.delete.i1", "legal.privacy.delete.i2", "legal.privacy.delete.i3"] },
  { heading: "legal.privacy.keep.h", paragraphs: ["legal.privacy.keep.p1", "legal.privacy.keep.p2"] },
  { heading: "legal.privacy.contact.h", paragraphs: ["legal.privacy.contact.p1"] },
];
