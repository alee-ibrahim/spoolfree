"use client";

import { DownloadIcon, Loader2Icon, ScanLineIcon, SearchIcon, ShieldAlertIcon } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { ScannerStateBadge } from "@/components/app/printer-status";
import {
  detectPrinterScanner,
  startTestScan,
  testScanOptions,
  type DetectScannerResult,
  type TestScanOptions,
  type TestScanStart,
} from "@/app/(admin)/test-scan-actions";

export type TestScanTarget = { printerId: string; printerName: string };

export function TestScanDialog({ target, onOpenChange }: { target: TestScanTarget | null; onOpenChange: (open: boolean) => void }) {
  const [reload, setReload] = useState(0);
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Test scan: {target?.printerName}</DialogTitle>
          <DialogDescription>
            Scans one page over eSCL (driverless scanning) and shows it here, so you can check the scanner works. One test scan per printer per minute.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed: a new target (or "Scan again") starts with fresh state. */}
        {target && <TestScanPanel key={`${target.printerId}:${reload}`} target={target} onAgain={() => setReload((n) => n + 1)} />}
      </DialogContent>
    </Dialog>
  );
}

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function TestScanPanel({ target, onAgain }: { target: TestScanTarget; onAgain: () => void }) {
  const [opts, setOpts] = useState<TestScanOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<"platen" | "feeder">("platen");
  const [color, setColor] = useState<"gray" | "color">("gray");
  const [result, setResult] = useState<Extract<TestScanStart, { ok: true }> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [detected, setDetected] = useState<Extract<DetectScannerResult, { ok: true }> | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    testScanOptions(target.printerId).then((o) => {
      if (cancelled) return;
      setOpts(o);
      setLoading(false);
      if (o?.scanner) {
        setSource(o.scanner.platen.available ? "platen" : "feeder");
        const src = o.scanner.platen.available ? o.scanner.platen : o.scanner.feeder;
        setColor(src.gray ? "gray" : "color");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const scanner = opts?.scanner ?? null;
  const caps = scanner ? (source === "platen" ? scanner.platen : scanner.feeder) : null;
  const status = opts?.status && "state" in opts.status ? opts.status : null;
  const statusError = opts?.status && "error" in opts.status ? opts.status.error : null;
  const busy = status?.state === "processing" || status?.state === "testing";
  const feederEmpty = source === "feeder" && status?.adfState === "Empty";
  const canScan = !pending && !result && !!caps?.available && (color === "color" ? caps.color : caps.gray);

  const scan = () =>
    start(async () => {
      setFailed(null);
      const r = await startTestScan({ printerId: target.printerId, source, color });
      if (!r.ok) {
        setFailed(r.error);
        toast.error(`Test scan failed: ${r.error}`);
        return;
      }
      setResult(r);
      toast.success("Page scanned");
    });

  const detect = () =>
    start(async () => {
      const r = await detectPrinterScanner(target.printerId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.found) {
        toast.success("Scanner found");
        onAgain();
      } else setDetected(r);
    });

  return (
    <>
      {loading && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {!loading && !opts && (
        <Alert variant="destructive">
          <AlertTitle>Not found</AlertTitle>
          <AlertDescription>The printer may have been deleted. Reload the page.</AlertDescription>
        </Alert>
      )}

      {opts && !scanner && (
        <div className="flex flex-col gap-3">
          <Alert>
            <ScanLineIcon />
            <AlertTitle>No scanner found</AlertTitle>
            <AlertDescription>
              {opts.checkedAgo
                ? `Spoolfree last looked ${opts.checkedAgo} and found no eSCL (AirScan) scanner on this device.`
                : "Spoolfree has not looked for a scanner on this device yet."}{" "}
              Printers without a scanner, and MFPs with eSCL turned off in their web settings, have none.
            </AlertDescription>
          </Alert>
          {detected && (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {detected.tried.map((t) => (
                <li key={t.url} className="break-all">
                  <span className="font-mono">{t.url}</span>: {t.result}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {opts && scanner && !result && (
        <FieldGroup>
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{scanner.model ?? "eSCL scanner"}</span>
              {status && <ScannerStateBadge state={status.state} adfState={status.adfState} showIdle />}
              {statusError && <Badge variant="outline">Status unavailable</Badge>}
            </div>
            <span className="font-mono text-xs break-all text-muted-foreground">{scanner.url}</span>
            {statusError && <span className="text-xs text-muted-foreground">{statusError}</span>}
          </div>

          <FieldSet>
            <FieldLegend variant="label">Scan from</FieldLegend>
            <RadioGroup value={source} onValueChange={(v) => setSource(v as "platen" | "feeder")} aria-label="Scan from">
              <FieldLabel htmlFor="ts-platen">
                <Field orientation="horizontal" data-disabled={!scanner.platen.available || undefined}>
                  <FieldContent>
                    <FieldTitle>Glass (flatbed)</FieldTitle>
                    <FieldDescription>{scanner.platen.available ? "Scans whatever is on the glass, or an empty glass." : "This scanner has no glass."}</FieldDescription>
                  </FieldContent>
                  <RadioGroupItem value="platen" id="ts-platen" disabled={!scanner.platen.available} />
                </Field>
              </FieldLabel>
              <FieldLabel htmlFor="ts-feeder">
                <Field orientation="horizontal" data-disabled={!scanner.feeder.available || undefined}>
                  <FieldContent>
                    <FieldTitle>Document feeder</FieldTitle>
                    <FieldDescription>
                      {!scanner.feeder.available
                        ? "This scanner has no document feeder."
                        : status?.adfState
                          ? `Feeder: ${status.adfState === "Empty" ? "empty, load a page first" : status.adfState === "Loaded" ? "paper loaded" : status.adfState}. Only the first page is scanned.`
                          : "Only the first page is scanned."}
                    </FieldDescription>
                  </FieldContent>
                  <RadioGroupItem value="feeder" id="ts-feeder" disabled={!scanner.feeder.available} />
                </Field>
              </FieldLabel>
            </RadioGroup>
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">Colour</FieldLegend>
            <RadioGroup value={color} onValueChange={(v) => setColor(v as "gray" | "color")} className="flex gap-6" aria-label="Colour">
              <Field orientation="horizontal" data-disabled={!caps?.gray || undefined} className="w-auto">
                <RadioGroupItem value="gray" id="ts-gray" disabled={!caps?.gray} />
                <FieldLabel htmlFor="ts-gray">Greyscale</FieldLabel>
              </Field>
              <Field orientation="horizontal" data-disabled={!caps?.color || undefined} className="w-auto">
                <RadioGroupItem value="color" id="ts-color" disabled={!caps?.color} />
                <FieldLabel htmlFor="ts-color">Colour</FieldLabel>
              </Field>
            </RadioGroup>
          </FieldSet>

          <Alert>
            <ShieldAlertIcon />
            <AlertTitle>Use a blank or test page</AlertTitle>
            <AlertDescription>
              The scanner scans whatever is on the glass or in the feeder, and the image is shown to you. It is not stored on the server; only the settings and
              the result are written to the audit log.
            </AlertDescription>
          </Alert>

          {busy && (
            <p className="text-sm text-muted-foreground" role="status">
              The scanner is busy right now; the test scan may be refused or wait until it is free.
            </p>
          )}
          {feederEmpty && (
            <p className="text-sm text-muted-foreground" role="status">
              The feeder reports no paper. Load a page or scan from the glass.
            </p>
          )}
          {pending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite">
              <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Scanning. Some scanners warm up first; this can take up to a minute.
            </p>
          )}
          {failed && !pending && (
            <Alert variant="destructive">
              <AlertTitle>Test scan failed</AlertTitle>
              <AlertDescription>{failed}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>
      )}

      {result && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
            <Badge>Scanned</Badge>
            <span className="text-sm text-muted-foreground">
              {result.settings} · {kb(result.bytes)} · {(result.durationMs / 1000).toFixed(1)} s
            </span>
          </div>
          {result.format === "application/pdf" ? (
            <p className="text-sm text-muted-foreground">The scanner only returns PDF here. Download it to look at the page.</p>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the scanner, not a static asset
            <img src={result.dataUrl} alt={`Test scan from ${target.printerName}`} className="max-h-[50svh] w-full rounded-md border bg-white object-contain" />
          )}
        </div>
      )}

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">{result ? "Close" : "Cancel"}</Button>
        </DialogClose>
        {opts && !scanner && (
          <Button onClick={detect} disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <SearchIcon />}
            Detect scanner
          </Button>
        )}
        {scanner && !result && (
          <Button onClick={scan} disabled={!canScan}>
            {pending ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <ScanLineIcon />}
            Start test scan
          </Button>
        )}
        {result && (
          <>
            <Button variant="secondary" asChild>
              <a href={result.dataUrl} download={`test-scan-${target.printerName.replace(/[^\w.-]+/g, "_")}.${result.format.split("/")[1]}`}>
                <DownloadIcon />
                Download
              </a>
            </Button>
            <Button onClick={onAgain}>Scan again</Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
