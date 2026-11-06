/**
 * pnpm seed:dev — fills an EMPTY development database with sample printers,
 * assignments for the DEV_FAKE_AD tree, and a few fake agent reports.
 * Refuses to run unless DEV_FAKE_AD=1 and NODE_ENV is not production.
 */
import { db, schema, sqlClient } from "../src/lib/db";
import { runMigrations } from "../src/lib/db/migrate";
import { fakeGuid } from "../src/lib/directory/fake";
import { sha256Hex, randomToken } from "../src/lib/crypto/signing";

if (process.env.NODE_ENV === "production" || process.env.DEV_FAKE_AD !== "1") {
  console.error("seed:dev only runs with DEV_FAKE_AD=1 outside production.");
  process.exit(1);
}

const W = "OU=Workstations,DC=example,DC=org";
const ADM = `OU=Administration,${W}`;
const FIN = `OU=Finance,${ADM}`;
const HR = `OU=HR,${ADM}`;
const TCH = `OU=Teaching,${W}`;
const LAB = `OU=Science Lab,${TCH}`;
const LIB = `OU=Library,${W}`;
const KIOSK = `OU=Kiosks,${LIB}`;

async function main() {
  await runMigrations();
  const d = db();
  const existing = await d.select().from(schema.printers).limit(1);
  if (existing.length && !process.argv.includes("--force")) {
    console.log("Database already has printers; use --force to wipe dev data and reseed.");
    return;
  }
  await sqlClient()`truncate printers, printer_status, ou_assignments, ou_settings, computer_overrides, agents, audit_log, print_jobs, printer_counter_daily restart identity cascade`;

  // Hosts 127.0.0.1:863x are served by scripts/fake-printers.ts; 192.0.2.x (TEST-NET-1) never answers.
  const rows = await d
    .insert(schema.printers)
    .values([
      { name: "Admin Office MFP", host: "127.0.0.1", port: 8631, location: "Admin block, ground floor", model: "Brother MFC-L8900CDW" },
      { name: "Finance Laser", host: "127.0.0.1", port: 8632, location: "Finance office", model: "HP LaserJet Pro M404dn" },
      { name: "Staff Room Copier", host: "127.0.0.1", port: 8633, location: "Staff room", model: "Canon iR-ADV DX C3826i", notes: "Lease ends 2027-06" },
      { name: "Science Lab Colour", host: "127.0.0.1", port: 8634, location: "Lab 2", model: "Epson WF-C5890" },
      { name: "Library Printer", host: "127.0.0.1", port: 8635, location: "Library desk", model: "Kyocera ECOSYS P3145dn" },
      { name: "Kiosk Receipt", host: "192.0.2.50", port: 631, location: "Library entrance", model: "Generic IPP receipt printer" },
    ])
    .returning();
  const id = Object.fromEntries(rows.map((r) => [r.name, r.id]));

  await d.insert(schema.ouAssignments).values([
    { ouDn: ADM, printerId: id["Admin Office MFP"] },
    { ouDn: FIN, printerId: id["Finance Laser"] },
    { ouDn: TCH, printerId: id["Staff Room Copier"] },
    { ouDn: LAB, printerId: id["Science Lab Colour"] },
    { ouDn: LIB, printerId: id["Library Printer"] },
    { ouDn: KIOSK, printerId: id["Kiosk Receipt"] },
  ]);
  await d.insert(schema.ouSettings).values([
    { ouDn: FIN, defaultPrinterId: id["Finance Laser"] },
    { ouDn: TCH, defaultPrinterId: id["Staff Room Copier"] },
    { ouDn: LAB, blockedPrinterIds: [id["Staff Room Copier"]], defaultPrinterId: id["Science Lab Colour"] },
    { ouDn: KIOSK, blockInheritance: true, defaultPrinterId: id["Kiosk Receipt"] },
  ]);
  await d.insert(schema.computerOverrides).values([
    { computerGuid: fakeGuid("HR-01"), computerName: "HR-01", printerId: id["Finance Laser"], action: "add", makeDefault: false },
  ]);

  const now = Date.now();
  const agent = (name: string, ou: string, minsAgo: number, applied: string[], def: string | null, errors: string[] = []) => ({
    objectGuid: fakeGuid(name),
    dn: `CN=${name},${ou}`,
    computerName: name,
    tokenHash: sha256Hex(randomToken()),
    enrolledAt: new Date(now - 20 * 86400_000),
    lastManifestAt: new Date(now - minsAgo * 60_000),
    lastReportAt: new Date(now - minsAgo * 60_000),
    lastReport: { agentVersion: "0.1.0", osVersion: "Windows 11 Enterprise 24H2 (26100)", method: "IppURL", applied, defaultPrinter: def, errors, added: [], removed: [] },
  });
  await d.insert(schema.agents).values([
    agent("ADM-01", ADM, 12, ["Admin Office MFP"], null),
    agent("FIN-01", FIN, 31, ["Admin Office MFP", "Finance Laser"], "Finance Laser"),
    agent("HR-01", HR, 47, ["Admin Office MFP", "Finance Laser"], null),
    agent("TCH-02", TCH, 8, ["Staff Room Copier"], "Staff Room Copier"),
    agent("LAB-01", LAB, 55, ["Science Lab Colour"], "Science Lab Colour"),
    agent("KIOSK-01", KIOSK, 22, [], null, ["Kiosk Receipt: Add-Printer -IppURL failed: the printer did not respond (192.0.2.50)"]),
    { ...agent("LIB-01", LIB, 60 * 52, ["Library Printer"], "Library Printer"), lastReport: { agentVersion: "0.1.0", osVersion: "Windows 10 Pro 22H2 (19045)", method: "TcpIpPort", applied: ["Library Printer"], defaultPrinter: null, errors: [] } },
  ]);

  await d.insert(schema.auditLog).values([
    { actor: "admin@example.org", action: "printer.create", entityType: "printer", entityId: id["Staff Room Copier"], details: { name: "Staff Room Copier" }, at: new Date(now - 3 * 86400_000) },
    { actor: "admin@example.org", action: "assignment.add", entityType: "ou", entityId: TCH, details: { printerId: id["Staff Room Copier"] }, at: new Date(now - 3 * 86400_000 + 60_000) },
    { actor: "admin@example.org", action: "ou.block_inheritance", entityType: "ou", entityId: KIOSK, details: null, at: new Date(now - 2 * 86400_000) },
    { actor: "admin@example.org", action: "printer.replace", entityType: "printer", entityId: id["Finance Laser"], details: { before: { host: "192.0.2.31" }, after: { host: "192.0.2.32" } }, at: new Date(now - 86400_000) },
  ]);
  const jobs = await seedAnalytics(id, now);
  console.log(`Seeded ${rows.length} printers, assignments, 7 sample agents and ${jobs} sample print jobs.`);
}

/** 60 days of fake print jobs (deterministic) and daily printer counters for the Analytics page. */
async function seedAnalytics(id: Record<string, string>, now: number): Promise<number> {
  const d = db();
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pcs = [
    { name: "ADM-01", ou: ADM, printer: "Admin Office MFP", users: ["EXAMPLE\\aisha", "EXAMPLE\\hassan"] },
    { name: "FIN-01", ou: FIN, printer: "Finance Laser", users: ["EXAMPLE\\mariyam", "EXAMPLE\\ibrahim"] },
    { name: "HR-01", ou: HR, printer: "Admin Office MFP", users: ["EXAMPLE\\fathimath"] },
    { name: "TCH-02", ou: TCH, printer: "Staff Room Copier", users: ["EXAMPLE\\ahmed", "EXAMPLE\\shifa", "EXAMPLE\\yoosuf"] },
    { name: "LAB-01", ou: LAB, printer: "Science Lab Colour", users: ["EXAMPLE\\naseem"] },
    { name: "LIB-01", ou: LIB, printer: "Library Printer", users: ["EXAMPLE\\librarian"] },
  ];
  const docs = ["Budget 2027.xlsx", "Minutes.docx", "Timetable.pdf", "Lab worksheet 4.docx", "Invoice 1182.pdf", "Leave form.pdf", "Report draft.docx"];
  const rows: (typeof schema.printJobs.$inferInsert)[] = [];
  const pcPages = new Map<string, number[]>();
  let rec = 1000;
  for (let day = 59; day >= 0; day--) {
    const date = new Date(now - day * 86400_000);
    const weekend = [5, 6].includes(date.getUTCDay());
    for (const pc of pcs) {
      const n = Math.floor(rnd() * (weekend ? 2 : 9));
      for (let i = 0; i < n; i++) {
        const at = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 3 + Math.floor(rnd() * 9), Math.floor(rnd() * 60)));
        if (at.getTime() > now) continue;
        const unmanaged = pc.name === "HR-01" && rnd() < 0.3;
        const pages = 1 + Math.floor(rnd() * rnd() * 30);
        const printer = unmanaged ? "HP LaserJet M404 (hand-installed)" : pc.printer;
        rows.push({
          computerGuid: fakeGuid(pc.name),
          computerName: pc.name,
          ouDn: pc.ou,
          recordId: rec++,
          printedAt: at,
          userName: pc.users[Math.floor(rnd() * pc.users.length)],
          clientComputer: pc.name,
          queueName: printer,
          printerId: unmanaged ? null : id[printer],
          port: unmanaged ? "192.0.2.77" : "WSD-0000",
          portHost: unmanaged ? "192.0.2.77" : "127.0.0.1",
          pages,
          bytes: pages * 48_000,
          documentName: docs[Math.floor(rnd() * docs.length)],
        });
        if (!unmanaged) {
          const list = pcPages.get(printer) ?? Array(60).fill(0);
          list[59 - day] += pages;
          pcPages.set(printer, list);
        }
      }
    }
  }
  for (let i = 0; i < rows.length; i += 500) await d.insert(schema.printJobs).values(rows.slice(i, i + 500));
  // Counters: PC pages plus copies/direct prints the PCs never saw.
  const counters: (typeof schema.printerCounterDaily.$inferInsert)[] = [];
  const base: Record<string, number> = { "Admin Office MFP": 48_000, "Finance Laser": 120_000, "Staff Room Copier": 301_000, "Science Lab Colour": 9_000, "Library Printer": 23_000 };
  for (const [name, start] of Object.entries(base)) {
    let count = start;
    const pcs = pcPages.get(name) ?? Array(60).fill(0);
    for (let day = 59; day >= 0; day--) {
      const extra = name === "Staff Room Copier" ? Math.floor(rnd() * 120) : Math.floor(rnd() * 15);
      const first = count;
      count += pcs[59 - day] + extra;
      const dd = new Date(now - day * 86400_000).toISOString().slice(0, 10);
      counters.push({ printerId: id[name], day: dd, revision: 1, firstCount: first, lastCount: count });
    }
  }
  await d.insert(schema.printerCounterDaily).values(counters);
  return rows.length;
}

main()
  .then(() => sqlClient().end())
  .catch(async (e) => {
    console.error(e);
    await sqlClient().end();
    process.exit(1);
  });
