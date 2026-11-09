"use client";

import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, Loader2Icon, MonitorIcon, PrinterIcon, ServerIcon } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import type { TestPrintState } from "@/lib/db/schema";
import type { TestPrintView } from "@/lib/test-print/service";
import {
  agentTestPrintOptions,
  startTestPrint,
  testPrintOptions,
  testPrintStatus,
  type AgentTestPrintOptions,
  type TestPrintOptions,
} from "@/app/(admin)/test-print-actions";

/** Test print dialog (0.8): from the printers list (both modes) or the agents list (one PC, pick a printer). */
export type TestPrintTarget = { kind: "printer"; printerId: string; printerName: string } | { kind: "agent"; agentId: string; computerName: string };

const STATE_LABEL: Record<TestPrintState, string> = {
  queued: "Queued",
  delivered: "Picked up",
  sent: "Sent",
  printing: "Printing",
  printed: "Printed",
  failed: "Failed",
  expired: "Expired",
  rejected: "Rejected",
};

function stateVariant(s: TestPrintState): "default" | "secondary" | "destructive" | "outline" {
  if (s === "printed") return "default";
  if (s === "failed" || s === "expired" || s === "rejected") return "destructive";
  return "secondary";
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function delayHint(pollMinutes: number, syncMinutes: number, ttlMinutes: number): string {
  const when = pollMinutes > 0 ? `within about ${pollMinutes} minute${pollMinutes === 1 ? "" : "s"}` : `at its next sync (every ${syncMinutes} minutes)`;
  return `The PC's agent picks the command up ${when}. It expires after ${ttlMinutes} minutes.`;
}

/** The steps a test print goes through; reached steps carry their time. */
function steps(t: TestPrintView): { state: TestPrintState; label: string; at: string | null; message: string | null }[] {
  const plan: [TestPrintState, string][] =
    t.mode === "pc"
      ? [
          ["queued", "Queued for the PC"],
          ["delivered", `Picked up by ${t.computerName ?? "the PC"}`],
          ["sent", "In the PC's print queue"],
        ]
      : [
          ["queued", "Prepared on the server"],
          ["sent", "Accepted by the printer"],
          ["printing", "Printing"],
        ];
  const reached = new Map(t.events.map((e) => [e.state, e]));
  const out = plan.map(([state, label]) => ({ state, label, at: reached.get(state)?.at ?? null, message: reached.get(state)?.message ?? null }));
  const final = t.events.find((e) => ["printed", "failed", "expired", "rejected"].includes(e.state));
  out.push(
    final
      ? { state: final.state, label: STATE_LABEL[final.state], at: final.at, message: final.message ?? t.error ?? null }
      : { state: "printed", label: "Printed", at: null, message: null },
  );
  // Direct jobs often go from accepted to completed without a "printing" sighting: drop the step when skipped.
  return out.filter((s) => s.at || s.state !== "printing" || !t.final);
}

function StepIcon({ state, reached, current }: { state: TestPrintState; reached: boolean; current: boolean }) {
  if (reached && (state === "failed" || state === "expired" || state === "rejected")) return <CircleXIcon className="text-destructive" />;
  if (reached) return <CircleCheckIcon className="text-primary" />;
  if (current) return <Loader2Icon className="animate-spin text-muted-foreground motion-reduce:animate-none" />;
  return <CircleDashedIcon className="text-muted-foreground" />;
}

export function TestPrintProgress({ t }: { t: TestPrintView }) {
  const list = steps(t);
  const firstPending = list.findIndex((s) => !s.at);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite" aria-atomic="true">
        <Badge variant={stateVariant(t.state)}>{STATE_LABEL[t.state]}</Badge>
        <span className="text-sm text-muted-foreground">
          {t.mode === "pc" ? `From ${t.computerName}` : "Direct from the server"} to {t.printerName}
        </span>
      </div>
      <ItemGroup className="gap-1">
        {list.map((s, i) => (
          <Item key={s.state + i} size="xs" variant={s.at ? "default" : "muted"}>
            <ItemMedia variant="icon">
              <StepIcon state={s.state} reached={!!s.at} current={!t.final && i === firstPending} />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className={s.at ? undefined : "text-muted-foreground"}>{s.label}</ItemTitle>
              {s.message && <ItemDescription className="break-words">{s.message}</ItemDescription>}
            </ItemContent>
            <span className="text-xs text-muted-foreground tabular-nums">{s.at ? time(s.at) : "—"}</span>
          </Item>
        ))}
      </ItemGroup>
      {(t.format || t.jobId !== null) && (
        <p className="text-xs text-muted-foreground">
          {t.format ? `Format: ${t.format}. ` : ""}
          {t.jobId !== null ? `Job ${t.jobId}${t.jobStatus ? `: ${t.jobStatus}` : ""}.` : ""}
        </p>
      )}
    </div>
  );
}

function useTestPrintPolling(t: TestPrintView | null, onUpdate: (t: TestPrintView) => void) {
  useEffect(() => {
    if (!t || t.final) return;
    const handle = setTimeout(
      async () => {
        const next = await testPrintStatus(t.id);
        if (next) onUpdate(next);
      },
      t.mode === "direct" ? 2000 : 5000,
    );
    return () => clearTimeout(handle);
  }, [t, onUpdate]);
}

function RecentList({ recent, showPc }: { recent: TestPrintView[]; showPc: boolean }) {
  if (!recent.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Recent test prints</p>
      <ItemGroup className="gap-1">
        {recent.map((r) => (
          <Item key={r.id} size="xs" variant="muted">
            <ItemMedia variant="icon">{r.mode === "pc" ? <MonitorIcon /> : <ServerIcon />}</ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="truncate">{showPc ? (r.mode === "pc" ? r.computerName : "Direct") : r.printerName}</ItemTitle>
              <ItemDescription className="truncate">
                {r.requestedBy} · {timeAgo(r.createdAt)}
              </ItemDescription>
            </ItemContent>
            <Badge variant={stateVariant(r.state)}>{STATE_LABEL[r.state]}</Badge>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}

/** A button that opens the test print dialog for one PC (Agents page). */
export function AgentTestPrintButton({ agentId, computerName }: { agentId: string; computerName: string }) {
  const [target, setTarget] = useState<TestPrintTarget | null>(null);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setTarget({ kind: "agent", agentId, computerName })}>
        <PrinterIcon data-icon="inline-start" />
        Test print
      </Button>
      <TestPrintDialog target={target} onOpenChange={(o) => !o && setTarget(null)} />
    </>
  );
}

export function TestPrintDialog({ target, onOpenChange }: { target: TestPrintTarget | null; onOpenChange: (open: boolean) => void }) {
  const [reload, setReload] = useState(0);
  const title = target?.kind === "agent" ? `Test print from ${target.computerName}` : `Test print: ${target?.kind === "printer" ? target.printerName : ""}`;
  const key = target ? `${target.kind}:${target.kind === "printer" ? target.printerId : target.agentId}:${reload}` : "none";
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {target?.kind === "agent"
              ? "Prints one test page through this PC's Spoolfree queue, with its driver. Driver problems such as pages of random characters show up on paper."
              : "Prints one page so you can check the printer, or a PC's queue and driver. One test print per printer per minute."}
          </DialogDescription>
        </DialogHeader>
        {/* Keyed: a new target (or "Test again") starts with fresh state. */}
        {target && <TestPrintPanel key={key} target={target} onAgain={() => setReload((n) => n + 1)} />}
      </DialogContent>
    </Dialog>
  );
}

function TestPrintPanel({ target, onAgain }: { target: TestPrintTarget; onAgain: () => void }) {
  const [opts, setOpts] = useState<TestPrintOptions | AgentTestPrintOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"direct" | "pc">("direct");
  const [agentId, setAgentId] = useState<string>("");
  const [printerId, setPrinterId] = useState<string>("");
  const [current, setCurrent] = useState<TestPrintView | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    const load = target.kind === "printer" ? testPrintOptions(target.printerId) : agentTestPrintOptions(target.agentId);
    load.then((o) => {
      if (cancelled) return;
      setOpts(o);
      setLoading(false);
      if (o && "direct" in o) {
        setMode(o.direct.enabled ? "direct" : "pc");
        setAgentId(o.pcs.find((p) => p.supported)?.agentId ?? "");
      } else if (o) {
        setPrinterId(o.printers[0]?.id ?? "");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [target]);

  useTestPrintPolling(current, setCurrent);

  const forPrinter = opts && "direct" in opts ? opts : null;
  const forAgent = opts && !("direct" in opts) ? opts : null;
  const supportedPcs = forPrinter?.pcs.filter((p) => p.supported) ?? [];
  const canSend =
    !pending && !current && (forPrinter ? (mode === "direct" ? forPrinter.direct.enabled : !!agentId) : forAgent ? forAgent.supported && !!printerId : false);

  const send = () =>
    start(async () => {
      const r = forPrinter
        ? await startTestPrint(
            mode === "direct" ? { mode: "direct", printerId: forPrinter.printerId } : { mode: "pc", printerId: forPrinter.printerId, agentId },
          )
        : await startTestPrint({ mode: "pc", printerId, agentId: forAgent!.agentId });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setCurrent(r.testPrint);
      if (r.testPrint.state === "failed") toast.error(`Test print failed: ${r.testPrint.error ?? "see details"}`);
      else toast.success(r.testPrint.mode === "pc" ? `Test print queued for ${r.testPrint.computerName}` : "Test page sent to the printer");
    });

  return (
    <>
      {loading && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {!loading && !opts && (
        <Alert variant="destructive">
          <AlertTitle>Not found</AlertTitle>
          <AlertDescription>It may have been deleted. Reload the page.</AlertDescription>
        </Alert>
      )}

      {current && <TestPrintProgress t={current} />}

      {!current && forPrinter && (
        <FieldGroup>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as "direct" | "pc")} aria-label="How to send the test page">
            <FieldLabel htmlFor="tp-direct">
              <Field orientation="horizontal" data-disabled={!forPrinter.direct.enabled || undefined}>
                <FieldContent>
                  <FieldTitle>
                    <ServerIcon className="size-4" aria-hidden /> Direct to printer (from server)
                  </FieldTitle>
                  <FieldDescription>
                    {forPrinter.direct.enabled
                      ? "The server sends one mono, one-sided page over IPP in a format the printer lists, and follows the job."
                      : forPrinter.direct.reason}
                  </FieldDescription>
                </FieldContent>
                <RadioGroupItem value="direct" id="tp-direct" disabled={!forPrinter.direct.enabled} />
              </Field>
            </FieldLabel>
            <FieldLabel htmlFor="tp-pc">
              <Field orientation="horizontal" data-disabled={!supportedPcs.length || undefined}>
                <FieldContent>
                  <FieldTitle>
                    <MonitorIcon className="size-4" aria-hidden /> From a PC (tests the PC&apos;s driver and queue)
                  </FieldTitle>
                  <FieldDescription>
                    {forPrinter.pcs.length === 0
                      ? "No PC has reported a queue for this printer yet."
                      : !supportedPcs.length
                        ? "The PCs with this printer run an agent older than 0.8.0. They update themselves at their next sync."
                        : delayHint(forPrinter.pollMinutes, forPrinter.syncMinutes, forPrinter.ttlMinutes)}
                  </FieldDescription>
                </FieldContent>
                <RadioGroupItem value="pc" id="tp-pc" disabled={!supportedPcs.length} />
              </Field>
            </FieldLabel>
          </RadioGroup>
          {mode === "pc" && supportedPcs.length > 0 && (
            <Field>
              <FieldLabel htmlFor="tp-pc-select">Computer</FieldLabel>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger id="tp-pc-select" className="w-full">
                  <SelectValue placeholder="Choose a PC" />
                </SelectTrigger>
                <SelectContent>
                  {forPrinter.pcs.map((p) => (
                    <SelectItem key={p.agentId} value={p.agentId} disabled={!p.supported}>
                      {p.computerName}
                      <span className="text-muted-foreground">
                        {p.supported ? ` · seen ${timeAgo(p.lastReportAt)}` : ` · agent ${p.agentVersion ?? "?"}, needs 0.8.0`}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>PCs whose last report lists this printer&apos;s queue.</FieldDescription>
            </Field>
          )}
          <RecentList recent={forPrinter.recent} showPc />
        </FieldGroup>
      )}

      {!current && forAgent && (
        <FieldGroup>
          {!forAgent.supported ? (
            <Alert>
              <PrinterIcon />
              <AlertTitle>Agent {forAgent.agentVersion ?? "unknown"} cannot run test prints</AlertTitle>
              <AlertDescription>Test prints need agent 0.8.0 or later. The PC updates itself at its next sync.</AlertDescription>
            </Alert>
          ) : forAgent.printers.length === 0 ? (
            <Alert>
              <PrinterIcon />
              <AlertTitle>No Spoolfree printers on this PC</AlertTitle>
              <AlertDescription>Its last report lists no queue of a printer on this server.</AlertDescription>
            </Alert>
          ) : (
            <Field>
              <FieldLabel htmlFor="tp-printer-select">Printer</FieldLabel>
              <Select value={printerId} onValueChange={setPrinterId}>
                <SelectTrigger id="tp-printer-select" className="w-full">
                  <SelectValue placeholder="Choose a printer" />
                </SelectTrigger>
                <SelectContent>
                  {forAgent.printers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{delayHint(forAgent.pollMinutes, forAgent.syncMinutes, forAgent.ttlMinutes)}</FieldDescription>
            </Field>
          )}
          <RecentList recent={forAgent.recent} showPc={false} />
        </FieldGroup>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">{current ? "Close" : "Cancel"}</Button>
        </DialogClose>
        {!current && (
          <Button onClick={send} disabled={!canSend}>
            {pending ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <PrinterIcon />}
            Send test page
          </Button>
        )}
        {current?.final && (
          <Button variant="secondary" onClick={onAgain}>
            Test again
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
