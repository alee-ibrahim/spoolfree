"use client";

import { CheckCircle2Icon, MoreHorizontalIcon, PlusIcon, PrinterIcon, XCircleIcon } from "lucide-react";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { deletePrinter, replacePrinter, savePrinter, testPrinter, type ActionResult, type TestResult } from "../actions";

export interface PrinterView {
  id: string;
  name: string;
  host: string;
  port: number;
  ippPath: string;
  useTls: boolean;
  location: string | null;
  model: string | null;
  notes: string | null;
  revision: number;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestFormats: string[];
  assignedOus: number;
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
        <Field>
          <FieldLabel htmlFor="host">IP address or hostname</FieldLabel>
          <Input id="host" name="host" required defaultValue={p?.host} placeholder="192.0.2.25" />
        </Field>
        <Field>
          <FieldLabel htmlFor="port">Port</FieldLabel>
          <Input id="port" name="port" type="number" defaultValue={p?.port ?? 631} />
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <Field>
          <FieldLabel htmlFor="ippPath">IPP path</FieldLabel>
          <Input id="ippPath" name="ippPath" defaultValue={p?.ippPath ?? "/ipp/print"} />
        </Field>
        <Field orientation="horizontal" className="pb-2">
          <Switch id="useTls" name="useTls" defaultChecked={p?.useTls ?? false} />
          <FieldLabel htmlFor="useTls">IPPS</FieldLabel>
        </Field>
      </div>
    </>
  );
}

export function PrinterFormDialog({ printer, trigger }: { printer?: PrinterView; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(savePrinter, null);
  useResultToast(state, () => setOpen(false));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm">
            <PlusIcon data-icon="inline-start" /> Add printer
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form action={action}>
          <DialogHeader>
            <DialogTitle>{printer ? `Edit ${printer.name}` : "Add printer"}</DialogTitle>
            <DialogDescription>
              The name is what users see on their PCs. It stays the same if you later replace the device.
            </DialogDescription>
          </DialogHeader>
          {printer && <input type="hidden" name="id" value={printer.id} />}
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" name="name" required defaultValue={printer?.name} placeholder="Staff Room Copier" />
            </Field>
            <EndpointFields p={printer} />
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="location">Location</FieldLabel>
                <Input id="location" name="location" defaultValue={printer?.location ?? ""} placeholder="Block A, level 1" />
              </Field>
              <Field>
                <FieldLabel htmlFor="model">Model</FieldLabel>
                <Input id="model" name="model" defaultValue={printer?.model ?? ""} placeholder="Brother MFC-L8900CDW" />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="notes">Notes</FieldLabel>
              <Textarea id="notes" name="notes" rows={2} defaultValue={printer?.notes ?? ""} />
            </Field>
          </FieldGroup>
          <DialogFooter>
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
      <DialogContent className="sm:max-w-lg">
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
            <EndpointFields p={{ ...printer, host: "" }} />
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

function TestDialog({ result, onOpenChange }: { result: (TestResult & { name: string }) | null; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={!!result} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>IPP test: {result?.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{result?.uri}</DialogDescription>
        </DialogHeader>
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
                  <TableCell className="text-muted-foreground">Model</TableCell>
                  <TableCell>{result.check.model ?? "—"}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">Driverless formats</TableCell>
                  <TableCell className="flex flex-wrap gap-1">
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
                <TableRow>
                  <TableCell className="text-muted-foreground">Colour / duplex</TableCell>
                  <TableCell>
                    {result.check.color === null ? "?" : result.check.color ? "Colour" : "Mono"} · {result.check.duplex ? "Duplex" : "Simplex"}
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

export function PrintersTable({ printers }: { printers: PrinterView[] }) {
  const [replacing, setReplacing] = useState<PrinterView | null>(null);
  const [deleting, setDeleting] = useState<PrinterView | null>(null);
  const [testResult, setTestResult] = useState<(TestResult & { name: string }) | null>(null);
  const [pending, startTransition] = useTransition();

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
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Driverless</TableHead>
              <TableHead className="text-right">OUs</TableHead>
              <TableHead className="w-10 pr-4" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {printers.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="pl-4 font-medium">
                  {p.name}
                  {p.revision > 1 && (
                    <Badge variant="outline" className="ml-2">
                      rev {p.revision}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {p.useTls ? "ipps" : "ipp"}://{p.host}:{p.port}
                  {p.ippPath}
                </TableCell>
                <TableCell>{p.location ?? "—"}</TableCell>
                <TableCell>{p.model ?? "—"}</TableCell>
                <TableCell>
                  {p.lastTestOk === null ? (
                    <Badge variant="outline">Not tested</Badge>
                  ) : p.lastTestOk ? (
                    <Badge variant="secondary">{p.lastTestFormats.map((f) => f.split("/")[1]).join(" · ")}</Badge>
                  ) : (
                    <Badge variant="destructive">Unsupported</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{p.assignedOus}</TableCell>
                <TableCell className="pr-4">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`}>
                        <MoreHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={pending}
                        onSelect={() =>
                          startTransition(async () => {
                            const r = await testPrinter(p.id);
                            setTestResult({ ...r, name: p.name });
                          })
                        }
                      >
                        Test (IPP)
                      </DropdownMenuItem>
                      <PrinterFormDialog printer={p} trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>Edit</DropdownMenuItem>} />
                      <DropdownMenuItem onSelect={() => setReplacing(p)}>Replace device…</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(p)}>
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {replacing && <ReplaceDialog printer={replacing} open onOpenChange={(o) => !o && setReplacing(null)} />}
      <TestDialog result={testResult} onOpenChange={(o) => !o && setTestResult(null)} />
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
