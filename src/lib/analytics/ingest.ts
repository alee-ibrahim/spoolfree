import { z } from "zod";

/** One PrintService event 307 as agents 0.5+ send it to /api/agent/jobs. */
export const PrintEvent = z.object({
  recordId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  time: z.iso.datetime({ offset: true }),
  user: z.string().max(256).nullable().optional(),
  userSid: z
    .string()
    .max(184)
    .regex(/^S-\d-\d+(-\d+)*$/i)
    .nullable()
    .optional(),
  clientComputer: z.string().max(256).nullable().optional(),
  printer: z.string().min(1).max(512),
  port: z.string().max(512).nullable().optional(),
  portHost: z.string().max(253).nullable().optional(),
  pages: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  document: z.string().max(4096).nullable().optional(),
  printerId: z.uuid().nullable().optional(),
});
export type PrintEvent = z.infer<typeof PrintEvent>;

export const JOBS_MAX_BATCH = 500;

export const JobsBatch = z.object({
  events: z.array(PrintEvent).max(JOBS_MAX_BATCH),
});

export interface IngestContext {
  agentId: string;
  computer: { objectGuid: string; name: string; dn: string };
  /** Spoolfree printers (id, queue name) to map queue names to. */
  printers: { id: string; name: string }[];
  collectDocumentNames: boolean;
}

export interface PrintJobRow {
  agentId: string;
  computerGuid: string;
  computerName: string;
  ouDn: string | null;
  recordId: number;
  printedAt: Date;
  userName: string | null;
  userSid: string | null;
  clientComputer: string | null;
  queueName: string;
  printerId: string | null;
  port: string | null;
  portHost: string | null;
  pages: number | null;
  bytes: number | null;
  documentName: string | null;
}

/** The DN of the OU (or container) that holds a computer: everything after the first RDN. */
export function parentDn(dn: string): string | null {
  const m = /^(?:[^,\\]|\\.)+,(.+)$/.exec(dn.trim());
  return m ? m[1] : null;
}

const clean = (v: string | null | undefined, max: number) => {
  const t = v?.trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Turns agent events into rows. The queue maps to a Spoolfree printer by the id the agent sent (when it is one of
 * ours) or by queue name (case-insensitive); unmanaged queues keep printerId null and their port host. Document
 * names are dropped unless collection is on, whatever the agent sent.
 */
export function toJobRows(events: PrintEvent[], ctx: IngestContext): PrintJobRow[] {
  const ids = new Set(ctx.printers.map((p) => p.id));
  const byName = new Map(ctx.printers.map((p) => [p.name.toLowerCase(), p.id]));
  const ouDn = parentDn(ctx.computer.dn);
  const seen = new Set<string>();
  const rows: PrintJobRow[] = [];
  for (const e of events) {
    const printedAt = new Date(e.time);
    const key = `${e.recordId}|${printedAt.toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const queueName = e.printer.trim().slice(0, 512);
    const printerId = (e.printerId && ids.has(e.printerId) ? e.printerId : null) ?? byName.get(queueName.toLowerCase()) ?? null;
    rows.push({
      agentId: ctx.agentId,
      computerGuid: ctx.computer.objectGuid,
      computerName: ctx.computer.name,
      ouDn,
      recordId: e.recordId,
      printedAt,
      userName: clean(e.user, 256),
      userSid: clean(e.userSid, 184),
      clientComputer: clean(e.clientComputer?.replace(/^\\\\+/, ""), 256),
      queueName,
      printerId,
      port: clean(e.port, 512),
      portHost: clean(e.portHost, 253)?.toLowerCase() ?? null,
      pages: e.pages ?? null,
      bytes: e.bytes ?? null,
      documentName: ctx.collectDocumentNames ? clean(e.document, 1024) : null,
    });
  }
  return rows;
}
