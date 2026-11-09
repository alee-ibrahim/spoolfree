/**
 * Small, dependency-free IPP/1.1-2.0 message encoder/decoder (RFC 8010).
 * Only what Spoolfree needs: building Get-Printer-Attributes requests and
 * parsing responses, including collections.
 */

export const Tag = {
  operationAttributes: 0x01,
  jobAttributes: 0x02,
  endOfAttributes: 0x03,
  printerAttributes: 0x04,
  unsupportedAttributes: 0x05,
  unsupported: 0x10,
  unknown: 0x12,
  noValue: 0x13,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  octetString: 0x30,
  dateTime: 0x31,
  resolution: 0x32,
  rangeOfInteger: 0x33,
  begCollection: 0x34,
  textWithLanguage: 0x35,
  nameWithLanguage: 0x36,
  endCollection: 0x37,
  textWithoutLanguage: 0x41,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  uriScheme: 0x46,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
  memberAttrName: 0x4a,
} as const;

export const Operation = {
  printJob: 0x0002,
  validateJob: 0x0004,
  getJobAttributes: 0x0009,
  getJobs: 0x000a,
  getPrinterAttributes: 0x000b,
} as const;

export type IppValue =
  | string
  | number
  | boolean
  | null
  | { x: number; y: number; units: number }
  | { lower: number; upper: number }
  | { [member: string]: IppValue | IppValue[] };

export interface IppAttribute {
  tag: number;
  name: string;
  values: IppValue[];
}

export interface IppRequestAttribute {
  tag: number;
  name: string;
  values: (string | number | boolean)[];
}

export interface IppRequest {
  version?: [number, number];
  operation: number;
  requestId: number;
  operationAttributes: IppRequestAttribute[];
}

export interface IppGroup {
  tag: number;
  attributes: Record<string, IppValue[]>;
}

export interface IppResponse {
  version: [number, number];
  statusCode: number;
  requestId: number;
  groups: IppGroup[];
}

class Writer {
  private chunks: Buffer[] = [];
  u8(n: number) {
    const b = Buffer.alloc(1);
    b.writeUInt8(n);
    this.chunks.push(b);
  }
  u16(n: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n);
    this.chunks.push(b);
  }
  i32(n: number) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    this.chunks.push(b);
  }
  bytes(b: Buffer) {
    this.chunks.push(b);
  }
  done(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function encodeValue(tag: number, value: string | number | boolean): Buffer {
  switch (tag) {
    case Tag.integer:
    case Tag.enum: {
      const b = Buffer.alloc(4);
      b.writeInt32BE(Number(value));
      return b;
    }
    case Tag.boolean:
      return Buffer.from([value ? 1 : 0]);
    case Tag.noValue:
    case Tag.unknown:
    case Tag.unsupported:
      return Buffer.alloc(0);
    default:
      return Buffer.from(String(value), "utf8");
  }
}

/** Encodes a request (code = operation-id) or response (code = status-code). */
export function encodeMessage(msg: {
  version?: [number, number];
  code: number;
  requestId: number;
  groups: { tag: number; attributes: IppRequestAttribute[] }[];
}): Buffer {
  const w = new Writer();
  const [major, minor] = msg.version ?? [2, 0];
  w.u8(major);
  w.u8(minor);
  w.u16(msg.code);
  w.i32(msg.requestId);
  for (const group of msg.groups) {
    w.u8(group.tag);
    for (const attr of group.attributes) {
      attr.values.forEach((v, i) => {
        const name = i === 0 ? Buffer.from(attr.name, "utf8") : Buffer.alloc(0);
        const value = encodeValue(attr.tag, v);
        if (value.length > 0xffff) throw new Error(`IPP value too long for ${attr.name}`);
        w.u8(attr.tag);
        w.u16(name.length);
        w.bytes(name);
        w.u16(value.length);
        w.bytes(value);
      });
    }
  }
  w.u8(Tag.endOfAttributes);
  return w.done();
}

export function encodeRequest(req: IppRequest): Buffer {
  return encodeMessage({
    version: req.version,
    code: req.operation,
    requestId: req.requestId,
    groups: [{ tag: Tag.operationAttributes, attributes: req.operationAttributes }],
  });
}

/** Parses a request header + operation attributes (used by tests and the dev printer simulator). */
export function decodeRequest(buf: Buffer): { version: [number, number]; operation: number; requestId: number; groups: IppGroup[] } {
  const r = decodeResponse(buf);
  return { version: r.version, operation: r.statusCode, requestId: r.requestId, groups: r.groups };
}

export function getPrinterAttributesRequest(
  printerUri: string,
  requested: string[],
  requestId = 1,
  version: [number, number] = [2, 0],
): Buffer {
  return encodeRequest({
    version,
    operation: Operation.getPrinterAttributes,
    requestId,
    operationAttributes: [
      { tag: Tag.charset, name: "attributes-charset", values: ["utf-8"] },
      { tag: Tag.naturalLanguage, name: "attributes-natural-language", values: ["en"] },
      { tag: Tag.uri, name: "printer-uri", values: [printerUri] },
      { tag: Tag.nameWithoutLanguage, name: "requesting-user-name", values: ["spoolfree"] },
      { tag: Tag.keyword, name: "requested-attributes", values: requested },
    ],
  });
}

/** Get-Jobs for which-jobs (e.g. "completed"), at most `limit` jobs, of all users. */
export function getJobsRequest(printerUri: string, requested: string[], whichJobs: string, limit: number, requestId = 1): Buffer {
  return encodeRequest({
    version: [2, 0],
    operation: Operation.getJobs,
    requestId,
    operationAttributes: [
      { tag: Tag.charset, name: "attributes-charset", values: ["utf-8"] },
      { tag: Tag.naturalLanguage, name: "attributes-natural-language", values: ["en"] },
      { tag: Tag.uri, name: "printer-uri", values: [printerUri] },
      { tag: Tag.nameWithoutLanguage, name: "requesting-user-name", values: ["spoolfree"] },
      { tag: Tag.keyword, name: "which-jobs", values: [whichJobs] },
      { tag: Tag.integer, name: "limit", values: [limit] },
      { tag: Tag.boolean, name: "my-jobs", values: [false] },
      { tag: Tag.keyword, name: "requested-attributes", values: requested },
    ],
  });
}

/**
 * Print-Job: operation attributes, optional job template attributes (only send what the printer lists as supported),
 * then the document bytes after end-of-attributes.
 */
export function printJobRequest(args: {
  printerUri: string;
  documentFormat: string;
  jobName: string;
  userName: string;
  jobAttributes: IppRequestAttribute[];
  document: Buffer;
  requestId?: number;
  version?: [number, number];
}): Buffer {
  const head = encodeMessage({
    version: args.version ?? [2, 0],
    code: Operation.printJob,
    requestId: args.requestId ?? 1,
    groups: [
      {
        tag: Tag.operationAttributes,
        attributes: [
          { tag: Tag.charset, name: "attributes-charset", values: ["utf-8"] },
          { tag: Tag.naturalLanguage, name: "attributes-natural-language", values: ["en"] },
          { tag: Tag.uri, name: "printer-uri", values: [args.printerUri] },
          { tag: Tag.nameWithoutLanguage, name: "requesting-user-name", values: [args.userName] },
          { tag: Tag.nameWithoutLanguage, name: "job-name", values: [args.jobName] },
          { tag: Tag.mimeMediaType, name: "document-format", values: [args.documentFormat] },
        ],
      },
      ...(args.jobAttributes.length ? [{ tag: Tag.jobAttributes, attributes: args.jobAttributes }] : []),
    ],
  });
  return Buffer.concat([head, args.document]);
}

/** Get-Job-Attributes for one job of a printer (by printer-uri + job-id, which every IPP printer supports). */
export function getJobAttributesRequest(printerUri: string, jobId: number, requested: string[], requestId = 1, version: [number, number] = [2, 0]): Buffer {
  return encodeRequest({
    version,
    operation: Operation.getJobAttributes,
    requestId,
    operationAttributes: [
      { tag: Tag.charset, name: "attributes-charset", values: ["utf-8"] },
      { tag: Tag.naturalLanguage, name: "attributes-natural-language", values: ["en"] },
      { tag: Tag.uri, name: "printer-uri", values: [printerUri] },
      { tag: Tag.integer, name: "job-id", values: [jobId] },
      { tag: Tag.nameWithoutLanguage, name: "requesting-user-name", values: ["spoolfree"] },
      { tag: Tag.keyword, name: "requested-attributes", values: requested },
    ],
  });
}

class Reader {
  constructor(
    private buf: Buffer,
    public pos = 0,
  ) {}
  ensure(n: number) {
    if (this.pos + n > this.buf.length) throw new Error("IPP message truncated");
  }
  u8() {
    this.ensure(1);
    return this.buf.readUInt8(this.pos++);
  }
  u16() {
    this.ensure(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i32() {
    this.ensure(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(n: number) {
    this.ensure(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  peek() {
    this.ensure(1);
    return this.buf.readUInt8(this.pos);
  }
  get remaining() {
    return this.buf.length - this.pos;
  }
}

function decodeValue(tag: number, raw: Buffer): IppValue {
  switch (tag) {
    case Tag.integer:
    case Tag.enum:
      return raw.length === 4 ? raw.readInt32BE(0) : null;
    case Tag.boolean:
      return raw.length >= 1 ? raw[0] !== 0 : null;
    case Tag.rangeOfInteger:
      return { lower: raw.readInt32BE(0), upper: raw.readInt32BE(4) };
    case Tag.resolution:
      return { x: raw.readInt32BE(0), y: raw.readInt32BE(4), units: raw.readInt8(8) };
    case Tag.dateTime: {
      if (raw.length < 11) return null;
      const year = raw.readUInt16BE(0);
      const d = new Date(Date.UTC(year, raw[2] - 1, raw[3], raw[4], raw[5], raw[6], raw[7] * 100));
      const sign = String.fromCharCode(raw[8]) === "-" ? 1 : -1;
      d.setUTCMinutes(d.getUTCMinutes() + sign * (raw[9] * 60 + raw[10]));
      return d.toISOString();
    }
    case Tag.textWithLanguage:
    case Tag.nameWithLanguage: {
      const langLen = raw.readUInt16BE(0);
      const textLen = raw.readUInt16BE(2 + langLen);
      return raw.subarray(4 + langLen, 4 + langLen + textLen).toString("utf8");
    }
    case Tag.unsupported:
    case Tag.unknown:
    case Tag.noValue:
      return null;
    case Tag.octetString:
      return raw.toString("utf8");
    default:
      return raw.toString("utf8");
  }
}

interface RawAttr {
  tag: number;
  name: string;
  value: Buffer;
}

function readRawAttr(r: Reader, tag: number): RawAttr {
  const nameLen = r.u16();
  const name = r.bytes(nameLen).toString("utf8");
  const valueLen = r.u16();
  const value = r.bytes(valueLen);
  return { tag, name, value };
}

/** Reads collection members until the matching endCollection. */
function readCollection(r: Reader): { [member: string]: IppValue | IppValue[] } {
  const out: { [member: string]: IppValue[] } = {};
  let member: string | null = null;
  while (r.remaining > 0) {
    const tag = r.u8();
    const a = readRawAttr(r, tag);
    if (tag === Tag.endCollection) break;
    if (tag === Tag.memberAttrName) {
      member = a.value.toString("utf8");
      out[member] = out[member] ?? [];
      continue;
    }
    if (member === null) continue;
    const v = tag === Tag.begCollection ? readCollection(r) : decodeValue(tag, a.value);
    out[member].push(v);
  }
  const flat: { [member: string]: IppValue | IppValue[] } = {};
  for (const [k, v] of Object.entries(out)) flat[k] = v.length === 1 ? v[0] : v;
  return flat;
}

export function decodeResponse(buf: Buffer): IppResponse {
  const r = new Reader(buf);
  const version: [number, number] = [r.u8(), r.u8()];
  const statusCode = r.u16();
  const requestId = r.i32();
  const groups: IppGroup[] = [];
  let group: IppGroup | null = null;
  let lastName: string | null = null;

  while (r.remaining > 0) {
    const tag = r.u8();
    if (tag === Tag.endOfAttributes) break;
    if (tag < 0x10) {
      group = { tag, attributes: {} };
      groups.push(group);
      lastName = null;
      continue;
    }
    const a = readRawAttr(r, tag);
    if (!group) throw new Error("IPP attribute outside of a group");
    const value = tag === Tag.begCollection ? readCollection(r) : decodeValue(tag, a.value);
    const name: string | null = a.name || lastName;
    if (!name) throw new Error("IPP additional value without attribute name");
    lastName = name;
    (group.attributes[name] ??= []).push(value);
  }
  return { version, statusCode, requestId, groups };
}

/** Merge printer-attributes groups into one record. */
export function printerAttributes(res: IppResponse): Record<string, IppValue[]> {
  const out: Record<string, IppValue[]> = {};
  for (const g of res.groups) {
    if (g.tag !== Tag.printerAttributes) continue;
    Object.assign(out, g.attributes);
  }
  return out;
}

export function isSuccess(statusCode: number): boolean {
  return statusCode >= 0x0000 && statusCode <= 0x00ff;
}
