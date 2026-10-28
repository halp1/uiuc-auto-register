// Course Explorer (courses.illinois.edu) XML client. Read-only, public, no seat counts.

import { XMLParser } from "fast-xml-parser";
import { explorerPath } from "../core/terms";
import type { Meeting } from "../core/types";
import type { FetchLike } from "../banner/enrollment";

export const EXPLORER_BASE = "https://courses.illinois.edu/cisapp/explorer/schedule";

export interface CatalogSection {
  crn: string;
  section: string;
  type: string;
  typeName: string;
  partOfTerm: string | null;
  meetings: Meeting[];
}

export interface CatalogCourse {
  term: string;
  subject: string;
  number: string;
  title: string;
  creditHours: string | null;
  description: string | null;
  scheduleInfo: string | null;
  sections: CatalogSection[];
}

export interface Subject {
  code: string;
  name: string;
}

const ARRAY_TAGS = new Set(["cascadingCourse", "detailedSection", "meeting", "instructor"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: name => ARRAY_TAGS.has(name),
});

type Node = Record<string, any>;

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return text((value as Node)["#text"]);
  const out = String(value).replace(/\s+/g, " ").trim();
  return out ? out : null;
}

function attr(node: unknown, name: string): string | null {
  if (!node || typeof node !== "object") return null;
  const value = (node as Node)[`@_${name}`];
  return value === undefined || value === null ? null : String(value).trim();
}

function list<T = Node>(value: unknown): T[] {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

/** "09:00AM" -> "09:00", "01:50PM" -> "13:50"; anything else (ARRANGED) -> null. */
export function to24h(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(value.trim());
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3]!.toUpperCase() === "P") hour += 12;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function parseMeeting(node: Node): Meeting {
  const days = text(node.daysOfTheWeek) ?? "";
  return {
    type: attr(node.type, "code") ?? "",
    typeName: text(node.type) ?? "",
    days: /^[MTWRFSU]+$/.test(days) ? days : "",
    start: to24h(text(node.start)),
    end: to24h(text(node.end)),
    building: text(node.buildingName),
    room: text(node.roomNumber),
    instructors: list(node.instructors?.instructor)
      .map(instructor => text(instructor))
      .filter((name): name is string => Boolean(name)),
  };
}

function parseSection(node: Node): CatalogSection | null {
  const crn = attr(node, "id");
  if (!crn || !/^\d{5}$/.test(crn)) return null;
  const meetings = list<Node>(node.meetings?.meeting).map(parseMeeting);
  const first = meetings[0];
  return {
    crn,
    section: text(node.sectionNumber) ?? "",
    type: first?.type ?? "",
    typeName: first?.typeName ?? "",
    partOfTerm: text(node.partOfTerm),
    meetings,
  };
}

function parseCourseNode(node: Node, term: string, subjectHint?: string): CatalogCourse | null {
  const id = attr(node, "id") ?? "";
  const match = /^([A-Z]+)\s+(\w+)$/.exec(id);
  const subject = match?.[1] ?? subjectHint ?? "";
  const number = match?.[2] ?? id;
  if (!subject || !number) return null;
  return {
    term,
    subject,
    number,
    title: text(node.label) ?? "",
    creditHours: text(node.creditHours)?.replace(/\.$/, "") ?? null,
    description: text(node.description),
    scheduleInfo: text(node.classScheduleInformation),
    sections: list<Node>(node.detailedSections?.detailedSection)
      .map(parseSection)
      .filter((section): section is CatalogSection => section !== null),
  };
}

/** Parse /schedule/{year}/{season}.xml into subjects. */
export function parseSubjects(xml: string): Subject[] {
  const root = parser.parse(xml) as Node;
  return list<Node>(root.term?.subjects?.subject)
    .map(node => ({ code: attr(node, "id") ?? "", name: text(node) ?? "" }))
    .filter(subject => subject.code);
}

/** Parse /schedule/{year}/{season}/{SUBJ}.xml?mode=cascade into courses with sections. */
export function parseCascade(xml: string, term: string): CatalogCourse[] {
  const root = parser.parse(xml) as Node;
  const subjectNode = root.subject as Node | undefined;
  const subject = attr(subjectNode, "id") ?? undefined;
  return list<Node>(subjectNode?.cascadingCourses?.cascadingCourse)
    .map(node => parseCourseNode(node, term, subject))
    .filter((course): course is CatalogCourse => course !== null);
}

/** Parse /schedule/{year}/{season}/{SUBJ}/{NUM}.xml?mode=detail. */
export function parseCourseDetail(xml: string, term: string): CatalogCourse | null {
  const root = parser.parse(xml) as Node;
  return root.course ? parseCourseNode(root.course as Node, term) : null;
}

export class ExplorerError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ExplorerError";
  }
}

export interface ExplorerOptions {
  fetch?: FetchLike;
  base?: string;
  timeoutMs?: number;
}

export class Explorer {
  private fetchImpl: FetchLike;
  private base: string;
  private timeoutMs: number;

  constructor(options: ExplorerOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.base = options.base ?? EXPLORER_BASE;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async get(path: string): Promise<string | null> {
    const response = await this.fetchImpl(`${this.base}/${path}`, {
      headers: { Accept: "application/xml" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new ExplorerError(`Course Explorer returned HTTP ${response.status} for ${path}`, response.status);
    return response.text();
  }

  async subjects(term: string): Promise<Subject[]> {
    const xml = await this.get(`${explorerPath(term)}.xml`);
    return xml ? parseSubjects(xml) : [];
  }

  async subjectCascade(term: string, subject: string): Promise<CatalogCourse[]> {
    const xml = await this.get(`${explorerPath(term)}/${encodeURIComponent(subject)}.xml?mode=cascade`);
    return xml ? parseCascade(xml, term) : [];
  }

  async course(term: string, subject: string, number: string): Promise<CatalogCourse | null> {
    const xml = await this.get(`${explorerPath(term)}/${encodeURIComponent(subject)}/${encodeURIComponent(number)}.xml?mode=detail`);
    return xml ? parseCourseDetail(xml, term) : null;
  }
}
