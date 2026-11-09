"use client";

import { CheckCircle2Icon, ChevronDownIcon, MoreHorizontalIcon, PlusIcon, PrinterIcon, XCircleIcon } from "lucide-react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { useActionState, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { PRINTER_NAME_RE, PRINTER_NAME_RULE } from "@/lib/printer-name";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { OuPicker, type OuOption, type PickedOu } from "@/components/app/ou-picker";
import { PcPicker, type PcOption, type PcOverride } from "@/components/app/pc-picker";
import { StatusBadges } from "@/components/app/printer-status";
import { TestPrintDialog, type TestPrintTarget } from "@/components/app/test-print-dialog";
import { OuBadges, PcBadges } from "@/components/app/assignment-badges";
import { cn } from "@/lib/utils";
import type { Marker } from "@/lib/ipp/interpret";
import { deletePrinter, previewPrinterReach, replacePrinter, resetDriverDecision, savePrinter, testPrinter, type ActionResult, type TestResult } from "../actions";

export interface DriverPackageOption {
  id: string;
  name: string;
  universal: boolean;
  drivers: string[];
}

export interface DriverDecisionView {
  mode: "driverless" | "vendor";
  source: "manual" | "auto";
  reason: string;
  needed: string | null;
  packageName: string | null;
  driverName: string | null;
  match: "manual" | "exact" | "universal" | null;
  /** Auto mode's vendor decision is stored and no longer re-evaluated. */
  sticky: boolean;
  /** 0.8.1: driverless printers: the package a PC uses when driverless fails there (per-PC vendor fallback). */
  fallbackPackageName: string | null;
  fallbackDriverName: string | null;
}

export interface PrinterView {
  id: string;
  name: string;
  host: string;
  port: number;
  ippPath: string;
  /** true: the path is detected by Test; false: manual override. */
  ippPathAuto: boolean;
  /** The full IPP address agents use. */
  ippUri: string;
  /** IPP version the device answered at the last Test ("2.0" / "1.1"). */
  ippVersion: string | null;
  useTls: boolean;
  location: string | null;
  model: string | null;
  notes: string | null;
  legacyTakeover: "off" | "dry-run" | "on";
  legacyShares: string[];
  legacyAliases: string[];
  defaultSides: "auto" | "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
  sidesSupported: string[] | null;
  sidesDefault: string | null;
  revision: number;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestFormats: string[];
  assignedOus: number;
  /** OU assignments, with whether this printer is the OU's default. */
  ous: PickedOu[];
  /** Per-computer overrides of this printer (add and block). */
  pcOverrides: PcOverride[];
  /** Full directory path of each assigned OU (badge tooltips); the DN's short form when AD is unavailable. */
  ouPaths: Record<string, string>;
  driverMode: "auto" | "driverless" | "vendor";
  driverPackageId: string | null;
  driverName: string | null;
  vendorProtocol: "raw9100" | "lpr" | "ipp";
  lprQueue: string | null;
  /** ipp-versions-supported at the last Test. */
  ippVersions: string[] | null;
  /** The driver PCs get now. */
  decision: DriverDecisionView;
  /** PCs whose agent reports this printer's queue on the per-PC vendor fallback (0.8.1). */
  vendorFallbackPcs: string[];
  /** Live status from the poller (null: not polled yet). */
  status: { online: boolean; state: string; stateReasons: string[]; markers: Marker[] } | null;
}

function useResultToast(state: ActionResult | null, onOk: () => void) {
  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message ?? "Saved");
      onOk();
    } else toast.error(state.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
}

function EndpointFields({ p }: { p?: Partial<PrinterView> }) {
  return (
    <>
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <HostField p={p} />
        <PortField p={p} />
      </div>
      <IppAddressField p={p} />
      <IppPathFields p={p} />
    </>
  );
}

function HostField({ p }: { p?: Partial<PrinterView> }) {
  return (
    <Field>
      <FieldLabel htmlFor="host">IP address or hostname</FieldLabel>
      <Input id="host" name="host" required defaultValue={p?.host} placeholder="192.0.2.25" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
    </Field>
  );
}

function PortField({ p }: { p?: Partial<PrinterView> }) {
  return (
    <Field>
      <FieldLabel htmlFor="port">Port</FieldLabel>
      <Input id="port" name="port" type="number" inputMode="numeric" defaultValue={p?.port ?? 631} />
    </Field>
  );
}

function IppAddressField({ p }: { p?: Partial<PrinterView> }) {
  return (
      <Field>
        <FieldLabel htmlFor="ippAddress">IPP address (auto)</FieldLabel>
        <Input
          id="ippAddress"
          readOnly
          tabIndex={-1}
          className="font-mono text-xs text-muted-foreground"
          value={p?.ippUri ? `${p.ippUri}${p.ippPathAuto === false ? " (manual)" : ""}` : "Detected when you save or test"}
        />
        <FieldDescription>
          Test tries /ipp/print, /ipp, /ipp/printer, /printers/lp1 and /, IPP 2.0 first and then 1.1, and keeps the first that
          answers.{p?.ippVersion ? ` Last answer: IPP ${p.ippVersion}.` : ""}
        </FieldDescription>
      </Field>
  );
}

function IppPathFields({ p }: { p?: Partial<PrinterView> }) {
  return (
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field>
          <FieldLabel htmlFor="ippPathOverride">IPP path override</FieldLabel>
          <Input
            id="ippPathOverride"
            name="ippPathOverride"
            defaultValue={p?.ippPathAuto === false ? p.ippPath : ""}
            placeholder="Empty = detect automatically"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>
        <Field orientation="horizontal" className="pb-2">
          <Switch id="useTls" name="useTls" defaultChecked={p?.useTls ?? false} />
          <FieldLabel htmlFor="useTls">IPPS</FieldLabel>
        </Field>
      </div>
  );
}

const SIDES_LABEL: Record<string, string> = {
  auto: "Driver default (don't change)",
  "one-sided": "One-sided",
  "two-sided-long-edge": "Two-sided, long edge (portrait)",
  "two-sided-short-edge": "Two-sided, short edge (landscape)",
};

function SidesField({ printer }: { printer?: PrinterView }) {
  const [sides, setSides] = useState<string>(printer?.defaultSides ?? "auto");
  const supported = printer?.sidesSupported ?? null;
  const unsupported = sides !== "auto" && supported !== null && !supported.includes(sides);
  return (
    <Field>
      <FieldLabel htmlFor="defaultSides">Default duplex</FieldLabel>
      <Select name="defaultSides" value={sides} onValueChange={setSides}>
        <SelectTrigger id="defaultSides" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(SIDES_LABEL).map(([v, label]) => (
            <SelectItem key={v} value={v}>
              {label}
              {supported && v !== "auto" && !supported.includes(v) ? " (not advertised)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {supported === null
          ? "Run Test to read the printer's sides-supported."
          : `Printer advertises: ${supported.join(", ") || "none"}${printer?.sidesDefault ? ` (default ${printer.sidesDefault})` : ""}.`}
      </FieldDescription>
      {unsupported && (
        <Alert variant="destructive">
          <AlertDescription>The printer does not advertise {sides}. PCs may ignore this setting.</AlertDescription>
        </Alert>
      )}
    </Field>
  );
}

const MODE_LABEL: Record<PrinterView["driverMode"], string> = {
  auto: "Auto (recommended): Spoolfree decides",
  driverless: "Driverless: Microsoft IPP Class Driver",
  vendor: "Vendor driver: a package you choose",
};

const PROTOCOL_LABEL: Record<PrinterView["vendorProtocol"], string> = {
  raw9100: "RAW, port 9100 (recommended)",
  lpr: "LPR, port 515",
  ipp: "IPP (Internet Port, IPP address above)",
};

/** One line saying which driver PCs get and why. */
export function decisionText(d: DriverDecisionView): string {
  if (d.mode === "vendor") return `${d.driverName} (${d.packageName}${d.match === "universal" ? ", universal" : ""}): ${d.reason}`;
  if (d.needed) return `Driverless for now: ${d.reason}; ${d.needed}`;
  const fallback = d.fallbackPackageName ? `; PCs where driverless fails use ${d.fallbackDriverName} (${d.fallbackPackageName})` : "";
  return `Driverless: ${d.reason}${fallback}`;
}

function DriverField({ printer, packages }: { printer?: PrinterView; packages: DriverPackageOption[] }) {
  const [mode, setMode] = useState<PrinterView["driverMode"]>(printer?.driverMode ?? "auto");
  const [pkgId, setPkgId] = useState<string>(printer?.driverPackageId ?? "");
  const [driver, setDriver] = useState<string>(printer?.driverName ?? "");
  const [protocol, setProtocol] = useState<PrinterView["vendorProtocol"]>(printer?.vendorProtocol ?? "raw9100");
  const pkg = packages.find((p) => p.id === pkgId) ?? null;
  const d = printer?.decision;
  // Suggest vendor mode for devices the IPP Class Driver handles badly (IPP 1.x only, not driverless).
  const ipp1Only = !!printer?.ippVersions?.length && !printer.ippVersions.some((v) => v.startsWith("2."));
  const suggest = mode === "driverless" && (ipp1Only || printer?.lastTestOk === false);
  return (
    <FieldGroup className="gap-4 rounded-lg border p-3">
      <Field>
        <FieldLabel htmlFor="driverMode">Driver</FieldLabel>
        <Select name="driverMode" value={mode} onValueChange={(v) => setMode(v as PrinterView["driverMode"])}>
          <SelectTrigger id="driverMode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(MODE_LABEL).map(([v, label]) => (
              <SelectItem key={v} value={v}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          {mode === "auto"
            ? "Vendor driver when the printer is IPP 1.x only, has no driverless format, or prints slowly (measured); driverless otherwise. Uses the matching package from Drivers."
            : mode === "vendor"
              ? "PCs install this signed driver package and print over a TCP/IP port. Use it only for printers that need it."
              : "No third-party driver code on PCs."}
        </FieldDescription>
        {d && mode === printer?.driverMode && (
          <p className="text-sm">
            <span className="text-muted-foreground">PCs get: </span>
            {decisionText(d)}
            {d.sticky ? " (decision kept until you change the mode)" : ""}
          </p>
        )}
        {suggest && (
          <Alert>
            <AlertTitle>Consider a vendor driver</AlertTitle>
            <AlertDescription>
              {ipp1Only ? `This printer answers IPP ${printer!.ippVersions!.join("/")} only.` : "The last Test found no driverless format."} Auto or vendor mode
              installs a vendor driver instead.
            </AlertDescription>
          </Alert>
        )}
      </Field>
      {mode === "vendor" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="driverPackageId">Driver package</FieldLabel>
            <Select
              name="driverPackageId"
              value={pkgId}
              onValueChange={(v) => {
                setPkgId(v);
                const next = packages.find((p) => p.id === v);
                setDriver(next?.drivers.length === 1 ? next.drivers[0] : "");
              }}
            >
              <SelectTrigger id="driverPackageId" className="w-full">
                <SelectValue placeholder={packages.length ? "Choose a package" : "No packages: upload one on Drivers"} />
              </SelectTrigger>
              <SelectContent>
                {packages.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.universal ? " (universal)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="driverName">Driver</FieldLabel>
            <Select name="driverName" value={driver} onValueChange={setDriver} disabled={!pkg}>
              <SelectTrigger id="driverName" className="w-full">
                <SelectValue placeholder="Choose the driver" />
              </SelectTrigger>
              <SelectContent>
                {(pkg?.drivers ?? []).map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      {mode === "driverless" && <input type="hidden" name="vendorProtocol" value={protocol} />}
      {mode !== "driverless" && (
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field>
            <FieldLabel htmlFor="vendorProtocol">Vendor driver port</FieldLabel>
            <Select name="vendorProtocol" value={protocol} onValueChange={(v) => setProtocol(v as PrinterView["vendorProtocol"])}>
              <SelectTrigger id="vendorProtocol" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PROTOCOL_LABEL).map(([v, label]) => (
                  <SelectItem key={v} value={v}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {protocol === "lpr" && (
            <Field>
              <FieldLabel htmlFor="lprQueue">LPR queue</FieldLabel>
              <Input id="lprQueue" name="lprQueue" defaultValue={printer?.lprQueue ?? ""} placeholder="lp" autoCapitalize="none" spellCheck={false} />
            </Field>
          )}
        </div>
      )}
    </FieldGroup>
  );
}

/** OU and PC picker state plus the debounced "will reach N computers" preview (OUs and PCs, each computer once). */
function useAssignSelection(printer: PrinterView | undefined, open: boolean) {
  const storedPcs = () => (printer?.pcOverrides ?? []).filter((o) => o.action === "add").map((o) => o.computerGuid.toLowerCase());
  const [ous, setOus] = useState<PickedOu[]>(printer?.ous ?? []);
  const [pcs, setPcs] = useState<string[]>(storedPcs);
  const [reach, setReach] = useState<{ key: string; result: { computers: number } | { error: string } } | null>(null);
  const key = JSON.stringify([ous.map((o) => o.ouDn), pcs]);
  const empty = ous.length === 0 && pcs.length === 0;
  useEffect(() => {
    if (!open || empty) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const [dns, guids] = JSON.parse(key) as [string[], string[]];
      const r = await previewPrinterReach(printer?.id ?? null, dns, guids).catch((e: Error) => ({ ok: false as const, error: e.message }));
      if (!cancelled) setReach({ key, result: r.ok ? { computers: r.computers } : { error: r.error } });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, key, empty, printer?.id]);
  /** Start from the stored assignments each time the dialog opens. */
  const reset = () => {
    setOus(printer?.ous ?? []);
    setPcs(storedPcs());
  };
  return { ous, setOus, pcs, setPcs, reset, empty, reach: reach?.result ?? null, reachPending: reach?.key !== key };
}

function ReachNote({ empty, reach, pending }: { empty: boolean; reach: { computers: number } | { error: string } | null; pending: boolean }) {
  return (
    <p className="-mt-3 text-sm text-muted-foreground" aria-live="polite">
      {empty
        ? "Not assigned yet: no PC gets this printer."
        : pending || reach === null
          ? "Counting computers…"
          : "error" in reach
            ? `Cannot count computers: ${reach.error}`
            : `Will reach ${reach.computers} computer${reach.computers === 1 ? "" : "s"} (OUs incl. child OUs, plus specific PCs; each counted once).`}
    </p>
  );
}

/** A collapsed section of the printer form. Its fields stay mounted (hidden) so they are always submitted. */
function FormSection({ title, hint, defaultOpen = false, children }: { title: string; hint: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="h-auto w-full justify-between gap-3 px-3 py-2.5 text-left font-normal">
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">{title}</span>
            <span className="text-xs whitespace-normal text-muted-foreground">{hint}</span>
          </span>
          <ChevronDownIcon className={cn("shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="data-[state=closed]:hidden">
        <FieldGroup className="gap-5 border-t p-3">{children}</FieldGroup>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function PrinterFormDialog({
  printer,
  trigger,
  ouOptions,
  pcOptions,
  packages,
  defaultLegacyTakeover = "on",
}: {
  printer?: PrinterView;
  trigger?: React.ReactNode;
  /** Directory OUs for the picker; null when the directory cannot be read. */
  ouOptions: OuOption[] | null;
  /** Directory computers for the PC picker; null when the directory cannot be read. */
  pcOptions: PcOption[] | null;
  /** Uploaded driver packages (vendor mode). */
  packages: DriverPackageOption[];
  /** Takeover for a new printer (server setting DEFAULT_LEGACY_TAKEOVER). */
  defaultLegacyTakeover?: "off" | "dry-run" | "on";
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(savePrinter, null);
  const { ous, setOus, pcs, setPcs, reset, empty, reach, reachPending } = useAssignSelection(printer, open);
  const hasShares = (printer?.legacyShares.length ?? 0) > 0;
  useResultToast(state, () => setOpen(false));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) reset();
        setOpen(o);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <PlusIcon data-icon="inline-start" /> Add printer
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <form action={action}>
          <DialogHeader>
            <DialogTitle>{printer ? `Edit ${printer.name}` : "Add printer"}</DialogTitle>
            <DialogDescription>
              The name is what users see on their PCs. It stays the same if you later replace the device.
            </DialogDescription>
          </DialogHeader>
          {printer && <input type="hidden" name="id" value={printer.id} />}
          <FieldGroup className="py-4">
            <PrinterNameField defaultValue={printer?.name} />
            <HostField p={printer} />
            <IppAddressField p={printer} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="location">Location</FieldLabel>
                <Input id="location" name="location" defaultValue={printer?.location ?? ""} placeholder="Block A, level 1" />
              </Field>
              <Field>
                <FieldLabel htmlFor="model">Model</FieldLabel>
                <Input id="model" name="model" defaultValue={printer?.model ?? ""} placeholder="Brother MFC-L8900CDW" />
              </Field>
            </div>
            {ouOptions && <input type="hidden" name="ous" value={JSON.stringify(ous)} />}
            <OuPicker options={ouOptions} value={ous} onChange={setOus} printerId={printer?.id ?? null} />
            {pcOptions && <input type="hidden" name="computers" value={JSON.stringify(pcs)} />}
            <PcPicker options={pcOptions} value={pcs} onChange={setPcs} stored={printer?.pcOverrides ?? []} />
            <ReachNote empty={empty} reach={reach} pending={reachPending} />
            <SidesField printer={printer} />
            <DriverField printer={printer} packages={packages} />
            <FormSection title="Connection and notes" hint="Port, IPP path override, IPPS, notes">
              <PortField p={printer} />
              <IppPathFields p={printer} />
              <Field>
                <FieldLabel htmlFor="notes">Notes</FieldLabel>
                <Textarea id="notes" name="notes" rows={2} defaultValue={printer?.notes ?? ""} />
              </Field>
            </FormSection>
            <FormSection title="Advanced (migration)" hint="Replace old queues for this device, legacy hostnames">
              <Field>
                <FieldLabel htmlFor="legacyTakeover">Replace existing queues for this device</FieldLabel>
                <Select name="legacyTakeover" defaultValue={printer?.legacyTakeover ?? defaultLegacyTakeover}>
                  <SelectTrigger id="legacyTakeover" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="on">On: remove them, then add this printer</SelectItem>
                    <SelectItem value="dry-run">Dry run: report what would be removed</SelectItem>
                    <SelectItem value="off">Off: never touch other queues</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Removes non-Spoolfree queues on PCs that print to this device (same IP or hostname, or a legacy hostname below), so
                  users do not see the printer twice. USB and virtual printers are never touched. A dry run only reports on Agents.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="legacyAliases">Legacy hostnames / aliases</FieldLabel>
                <Input
                  id="legacyAliases"
                  name="legacyAliases"
                  defaultValue={(printer?.legacyAliases ?? []).join(", ")}
                  placeholder="OLD-PRINTER-NAME, old-printer.example.org"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <FieldDescription>
                  Old names TCP/IP ports may still point at, e.g. a NetBIOS-style name that is not in DNS. Takeover matches a port
                  host equal to any of them (case-insensitive, &quot;.local&quot; optional).
                </FieldDescription>
              </Field>
              {hasShares && (
                <Field>
                  <FieldLabel htmlFor="legacyShares">Shares on the old print servers</FieldLabel>
                  <Input id="legacyShares" name="legacyShares" defaultValue={(printer?.legacyShares ?? []).join(", ")} />
                  <FieldDescription>Comma-separated share names on the servers in LEGACY_PRINT_SERVERS. Clear it to stop matching them.</FieldDescription>
                </Field>
              )}
            </FormSection>
          </FieldGroup>
          <DialogFooter className="sticky -bottom-4 z-10 -mx-4 -mb-4 border-t bg-background p-4 sm:static sm:m-0 sm:border-0 sm:p-0">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReplaceDialog({ printer, open, onOpenChange }: { printer: PrinterView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [state, action, pending] = useActionState(replacePrinter, null);
  useResultToast(state, () => onOpenChange(false));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <form action={action}>
          <DialogHeader>
            <DialogTitle>Replace device behind “{printer.name}”</DialogTitle>
            <DialogDescription>
              Point this logical printer at a new device. PCs keep the same printer name and pick up the new address at their next sync
              (revision {printer.revision} → {printer.revision + 1}).
            </DialogDescription>
          </DialogHeader>
          <input type="hidden" name="id" value={printer.id} />
          <FieldGroup className="py-4">
            <EndpointFields p={{ ...printer, host: "", ippUri: undefined, ippVersion: null }} />
            <Field>
              <FieldLabel htmlFor="model">New model</FieldLabel>
              <Input id="model" name="model" defaultValue={printer.model ?? ""} />
              <FieldDescription>Currently {printer.host}{printer.model ? ` (${printer.model})` : ""}.</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Replacing…" : "Replace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TestDialog({ result, onOpenChange }: { result: (TestResult & { name: string; decision?: DriverDecisionView }) | null; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={!!result} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>IPP test: {result?.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">{result?.uri}</DialogDescription>
        </DialogHeader>
        {result?.detection && <DetectionNote d={result.detection} />}
        {result && !result.ok && (
          <Alert variant="destructive">
            <XCircleIcon />
            <AlertTitle>Printer did not answer</AlertTitle>
            <AlertDescription>{result.error}</AlertDescription>
          </Alert>
        )}
        {result?.ok && (
          <div className="flex flex-col gap-3">
            <Alert variant={result.check.ok ? "default" : "destructive"}>
              {result.check.ok ? <CheckCircle2Icon /> : <XCircleIcon />}
              <AlertTitle>{result.check.ok ? "Driverless printing supported" : "Not driverless-capable"}</AlertTitle>
              <AlertDescription>
                {result.check.problems.length ? result.check.problems.join(" ") : "Windows can use the Microsoft IPP Class Driver for this printer."}
              </AlertDescription>
            </Alert>
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell className="text-muted-foreground">IPP address</TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-all">
                    {result.uri}
                    {result.detection.version ? ` (IPP ${result.detection.version})` : ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Model</TableCell>
                  <TableCell>{result.check.model ?? "—"}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Driverless formats</TableCell>
                  <TableCell className="flex flex-wrap gap-1 whitespace-normal">
                    {result.check.driverlessFormats.map((f) => (
                      <Badge key={f} variant="secondary">
                        {f}
                      </Badge>
                    ))}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">IPP versions</TableCell>
                  <TableCell>{result.check.ippVersions.join(", ") || "—"}</TableCell>
                </TableRow>
                {result.check.deviceId && (
                  <TableRow>
                    <TableCell className="text-muted-foreground">Device ID</TableCell>
                    <TableCell className="font-mono text-xs whitespace-normal break-all">{result.check.deviceId}</TableCell>
                  </TableRow>
                )}
                {result.decision && (
                  <TableRow>
                    <TableCell className="text-muted-foreground">Driver on PCs</TableCell>
                    <TableCell className="whitespace-normal">
                      {decisionText(result.decision)}
                      <div className="text-xs text-muted-foreground">Updated on the Printers page after the Test.</div>
                    </TableCell>
                  </TableRow>
                )}
                <TableRow>
                  <TableCell className="text-muted-foreground">Colour / duplex</TableCell>
                  <TableCell className="whitespace-normal">
                    {result.check.color === null ? "?" : result.check.color ? "Colour" : "Mono"} · {result.check.duplex ? "Duplex" : "Simplex"}
                    {result.check.sidesSupported && (
                      <div className="text-xs text-muted-foreground">
                        sides-supported: {result.check.sidesSupported.join(", ") || "none"}
                        {result.check.sidesDefault ? ` · sides-default: ${result.check.sidesDefault}` : ""}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetectionNote({ d }: { d: NonNullable<TestResult["detection"]> }) {
  if (!d.auto) return <p className="text-sm text-muted-foreground">Manual IPP path: only that path was tested.</p>;
  if (!d.path) {
    return (
      <p className="text-sm text-muted-foreground">
        Auto-detect tried {d.tried.length} address{d.tried.length === 1 ? "" : "es"}; none answered.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {d.changed
        ? `IPP path detected: ${d.path}. Saved; PCs re-create the queue at their next sync.`
        : `IPP path ${d.path} confirmed (auto).`}
    </p>
  );
}

function PrinterActions({
  p,
  ouOptions,
  pcOptions,
  packages,
  pending,
  onTest,
  onTestPrint,
  onReplace,
  onDelete,
}: {
  p: PrinterView;
  ouOptions: OuOption[] | null;
  pcOptions: PcOption[] | null;
  packages: DriverPackageOption[];
  pending: boolean;
  onTest: () => void;
  onTestPrint: () => void;
  onReplace: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={pending} onSelect={onTest}>
          Test (IPP)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onTestPrint}>Test print…</DropdownMenuItem>
        <PrinterFormDialog
          printer={p}
          ouOptions={ouOptions}
          pcOptions={pcOptions}
          packages={packages}
          trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>Edit</DropdownMenuItem>}
        />
        <DropdownMenuItem onSelect={onReplace}>Replace device…</DropdownMenuItem>
        {p.driverMode === "auto" && p.decision.sticky && (
          <DropdownMenuItem
            disabled={pending}
            onSelect={async () => {
              const r = await resetDriverDecision(p.id);
              if (r.ok) toast.success(r.message ?? "Reset");
              else toast.error(r.error);
            }}
          >
            Re-evaluate driver (auto)
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DriverBadge({ p }: { p: PrinterView }) {
  const d = p.decision;
  if (d.mode === "vendor")
    return (
      <Badge variant="outline" title={decisionText(d)}>
        Vendor{d.source === "auto" ? " (auto)" : ""}
      </Badge>
    );
  if (d.needed)
    return (
      <Badge variant="destructive" title={decisionText(d)}>
        Vendor driver needed
      </Badge>
    );
  return null;
}

/** PCs where driverless failed and the agent uses the vendor fallback package for this printer (0.8.1). */
function VendorFallbackBadge({ p }: { p: PrinterView }) {
  const n = p.vendorFallbackPcs.length;
  if (!n) return null;
  return (
    <Badge variant="outline" title={`Vendor fallback (${p.decision.fallbackDriverName ?? "vendor driver"}) on: ${p.vendorFallbackPcs.join(", ")}`}>
      Vendor fallback on {n} PC{n === 1 ? "" : "s"}
    </Badge>
  );
}

function DriverlessBadge({ p }: { p: PrinterView }) {
  if (p.lastTestOk === null) return <Badge variant="outline">Not tested</Badge>;
  if (p.lastTestOk) return <Badge variant="secondary">{p.lastTestFormats.map((f) => f.split("/")[1]).join(" · ")}</Badge>;
  return <Badge variant="destructive">Unsupported</Badge>;
}

export function PrintersTable({
  printers,
  ouOptions,
  pcOptions,
  packages,
}: {
  printers: PrinterView[];
  ouOptions: OuOption[] | null;
  pcOptions: PcOption[] | null;
  packages: DriverPackageOption[];
}) {
  const [replacing, setReplacing] = useState<PrinterView | null>(null);
  const [deleting, setDeleting] = useState<PrinterView | null>(null);
  const [testResult, setTestResult] = useState<(TestResult & { name: string; decision?: DriverDecisionView }) | null>(null);
  const [testPrint, setTestPrint] = useState<TestPrintTarget | null>(null);
  const openTestPrint = (p: PrinterView) => setTestPrint({ kind: "printer", printerId: p.id, printerName: p.name });
  const [pending, startTransition] = useTransition();
  const runTest = (p: PrinterView) =>
    startTransition(async () => {
      const r = await testPrinter(p.id);
      setTestResult({ ...r, name: p.name, decision: p.decision });
    });

  if (printers.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PrinterIcon />
          </EmptyMedia>
          <EmptyTitle>No printers</EmptyTitle>
          <EmptyDescription>Add a network printer that supports IPP Everywhere, AirPrint or Mopria.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      {/* Phones: one row per printer with its actions; the table from md up. */}
      <ItemGroup className="gap-3 md:hidden">
        {printers.map((p) => (
          <Item key={p.id} variant="outline" className="items-start">
            <ItemContent className="min-w-0">
              <ItemTitle className="flex-wrap">
                {p.name}
                {p.revision > 1 && <Badge variant="outline">rev {p.revision}</Badge>}
              </ItemTitle>
              <ItemDescription className="font-mono text-xs break-all">{p.ippUri}</ItemDescription>
              <ItemDescription>
                {p.location ?? "No location"}
                {p.model ? ` · ${p.model}` : ""}
              </ItemDescription>
              <div className="flex items-start gap-2 pt-1 text-xs">
                <span className="w-8 shrink-0 pt-0.5 text-muted-foreground">OUs</span>
                <OuBadges ous={p.ous} paths={p.ouPaths} empty="Not assigned" />
              </div>
              {p.pcOverrides.length > 0 && (
                <div className="flex items-start gap-2 text-xs">
                  <span className="w-8 shrink-0 pt-0.5 text-muted-foreground">PCs</span>
                  <PcBadges pcs={p.pcOverrides} />
                </div>
              )}
              <div className="pt-1">
                <StatusBadges status={p.status} />
              </div>
              <div className="flex flex-wrap gap-1 pt-1">
                <DriverlessBadge p={p} />
                <DriverBadge p={p} />
                <VendorFallbackBadge p={p} />
              </div>
            </ItemContent>
            <ItemActions className="flex-col items-end">
              <Button variant="outline" size="sm" onClick={() => openTestPrint(p)} aria-label={`Test print ${p.name}`}>
                <PrinterIcon data-icon="inline-start" />
                Test print
              </Button>
              <PrinterActions p={p} ouOptions={ouOptions} pcOptions={pcOptions} packages={packages} pending={pending} onTest={() => runTest(p)} onTestPrint={() => openTestPrint(p)} onReplace={() => setReplacing(p)} onDelete={() => setDeleting(p)} />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <Card className="hidden py-0 md:flex">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>IPP address</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Driverless</TableHead>
              <TableHead>OUs</TableHead>
              <TableHead>PCs</TableHead>
              <TableHead className="w-20 pr-4">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {printers.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="max-w-56 pl-4 whitespace-normal">
                  <div className="font-medium">
                    {p.name}
                    {p.revision > 1 && (
                      <Badge variant="outline" className="ml-2">
                        rev {p.revision}
                      </Badge>
                    )}
                  </div>
                  {p.model && <div className="text-xs text-muted-foreground">{p.model}</div>}
                </TableCell>
                <TableCell className="max-w-52 font-mono text-xs break-all whitespace-normal">
                  {p.ippUri}
                  {!p.ippPathAuto && <span className="ml-1 font-sans text-muted-foreground">(manual)</span>}
                </TableCell>
                <TableCell className="max-w-48 whitespace-normal">
                  <StatusBadges status={p.status} />
                </TableCell>
                <TableCell className="max-w-40 whitespace-normal">{p.location ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <DriverlessBadge p={p} />
                    <DriverBadge p={p} />
                    <VendorFallbackBadge p={p} />
                  </div>
                </TableCell>
                <TableCell className="max-w-56 whitespace-normal">
                  <OuBadges ous={p.ous} paths={p.ouPaths} />
                </TableCell>
                <TableCell className="max-w-48 whitespace-normal">
                  <PcBadges pcs={p.pcOverrides} />
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => openTestPrint(p)} aria-label={`Test print ${p.name}`} title="Test print">
                      <PrinterIcon />
                    </Button>
                    <PrinterActions p={p} ouOptions={ouOptions} pcOptions={pcOptions} packages={packages} pending={pending} onTest={() => runTest(p)} onTestPrint={() => openTestPrint(p)} onReplace={() => setReplacing(p)} onDelete={() => setDeleting(p)} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {replacing && <ReplaceDialog printer={replacing} open onOpenChange={(o) => !o && setReplacing(null)} />}
      <TestDialog result={testResult} onOpenChange={(o) => !o && setTestResult(null)} />
      <TestPrintDialog target={testPrint} onOpenChange={(o) => !o && setTestPrint(null)} />
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its OU assignments and overrides are removed too. Agents delete the queue from PCs at their next sync.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                deleting &&
                startTransition(async () => {
                  const r = await deletePrinter(deleting.id);
                  if (r.ok) toast.success(r.message ?? "Deleted");
                  else toast.error(r.error);
                  setDeleting(null);
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The queue name, checked as the admin types (the server checks it again): no \ / , ! " or control characters. */
function PrinterNameField({ defaultValue }: { defaultValue?: string }) {
  const [value, setValue] = useState(defaultValue ?? "");
  const trimmed = value.trim();
  const error = trimmed && !PRINTER_NAME_RE.test(trimmed) ? PRINTER_NAME_RULE : null;
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor="name">Name</FieldLabel>
      <Input id="name" name="name" required maxLength={100} value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={error ? true : undefined} placeholder="Staff Room Copier" />
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}
