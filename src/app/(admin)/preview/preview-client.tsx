"use client";

import { XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { addOverride, removeOverride, setComputerUnmanaged } from "../actions";

export function ComputerPicker({
  computers,
  selected,
}: {
  computers: { guid: string; name: string; ou: string }[];
  selected: string | null;
}) {
  const router = useRouter();
  const groups = new Map<string, typeof computers>();
  for (const c of computers) groups.set(c.ou, [...(groups.get(c.ou) ?? []), c]);
  return (
    <Select value={selected ?? undefined} onValueChange={(v) => router.push(`/preview?computer=${v}`)}>
      <SelectTrigger className="w-full sm:w-64" aria-label="Computer">
        <SelectValue placeholder="Choose a computer" />
      </SelectTrigger>
      <SelectContent>
        {[...groups.entries()].map(([ou, list]) => (
          <SelectGroup key={ou}>
            <SelectLabel>{ou || "Domain root"}</SelectLabel>
            {list.map((c) => (
              <SelectItem key={c.guid} value={c.guid}>
                {c.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

export function OverridesEditor({
  computer,
  printers,
  overrides,
}: {
  computer: { guid: string; name: string };
  printers: { id: string; name: string }[];
  overrides: { id: string; printerId: string; action: "add" | "block"; makeDefault: boolean }[];
}) {
  const [printerId, setPrinterId] = useState("");
  const [action, setAction] = useState<"add" | "block">("add");
  const [makeDefault, setMakeDefault] = useState(false);
  const [pending, start] = useTransition();
  const name = (id: string) => printers.find((p) => p.id === id)?.name ?? "(deleted)";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overrides for {computer.name}</CardTitle>
        <CardDescription>Add a printer only this computer gets, or block one it would inherit.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {overrides.length > 0 && (
          <Table>
            <TableBody>
              {overrides.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>
                    <Badge variant={o.action === "add" ? "secondary" : "destructive"}>{o.action === "add" ? "Add" : "Block"}</Badge>
                  </TableCell>
                  <TableCell className="font-medium">
                    {name(o.printerId)} {o.makeDefault && <Badge variant="outline">default</Badge>}
                  </TableCell>
                  <TableCell className="w-10 text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove override"
                      disabled={pending}
                      onClick={() => start(async () => void (await removeOverride(o.id)))}
                    >
                      <XIcon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Select value={action} onValueChange={(v) => setAction(v as "add" | "block")}>
            <SelectTrigger className="w-28" aria-label="Override type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add">Add</SelectItem>
              <SelectItem value="block">Block</SelectItem>
            </SelectContent>
          </Select>
          <Select value={printerId} onValueChange={setPrinterId}>
            <SelectTrigger className="w-full sm:w-56" aria-label="Printer">
              <SelectValue placeholder="Choose a printer" />
            </SelectTrigger>
            <SelectContent>
              {printers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {action === "add" && (
            <div className="flex items-center gap-2">
              <Checkbox id="make-default" checked={makeDefault} onCheckedChange={(v) => setMakeDefault(v === true)} />
              <Label htmlFor="make-default">Make default</Label>
            </div>
          )}
          <Button
            size="sm"
            disabled={!printerId || pending}
            onClick={() =>
              start(async () => {
                const r = await addOverride({ computerGuid: computer.guid, printerId, action, makeDefault: action === "add" && makeDefault });
                if (r.ok) {
                  toast.success("Override saved");
                  setPrinterId("");
                } else toast.error(r.error);
              })
            }
          >
            Save override
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

type UnmanagedMode = "off" | "dry-run" | "on";
const MODE_LABEL: Record<UnmanagedMode, string> = { off: "Off (report only)", "dry-run": "Dry-run", on: "On (remove)" };
const AS_OU = "__ou__";

/**
 * Per-PC override of "Remove unmanaged printers" and "keep USB/local printers" (0.9.0). The keep list is set per OU.
 */
export function ComputerUnmanagedEditor({
  computer,
  own,
  ou,
}: {
  computer: { guid: string; name: string };
  /** This PC's own values (null = as the OU says). */
  own: { mode: UnmanagedMode | null; keepLocal: boolean | null };
  /** What the OUs say, and from where. */
  ou: { mode: UnmanagedMode; modeFrom: string; keepLocal: boolean; keepLocalFrom: string };
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (patch: { removeUnmanaged?: UnmanagedMode | null; keepLocalPrinters?: boolean | null }) =>
    start(async () => {
      const r = await setComputerUnmanaged({ computerGuid: computer.guid, ...patch });
      if (!r.ok) toast.error(r.error);
      else {
        toast.success(`Saved for ${computer.name}`);
        router.refresh();
      }
    });
  return (
    <div className="flex flex-col gap-4">
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pc-unmanaged-mode">Remove unmanaged printers on this PC</FieldLabel>
          <FieldDescription>Overrides the OU setting for {computer.name} only.</FieldDescription>
        </FieldContent>
        <Select value={own.mode ?? AS_OU} disabled={pending} onValueChange={(v) => run({ removeUnmanaged: v === AS_OU ? null : (v as UnmanagedMode) })}>
          <SelectTrigger id="pc-unmanaged-mode" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AS_OU}>
              As the OU says ({MODE_LABEL[ou.mode]}, {ou.modeFrom})
            </SelectItem>
            <SelectItem value="off">{MODE_LABEL.off}</SelectItem>
            <SelectItem value="dry-run">{MODE_LABEL["dry-run"]}</SelectItem>
            <SelectItem value="on">{MODE_LABEL.on}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="pc-unmanaged-local">Keep USB/local printers on this PC</FieldLabel>
        </FieldContent>
        <Select
          value={own.keepLocal === null ? AS_OU : own.keepLocal ? "keep" : "remove"}
          disabled={pending}
          onValueChange={(v) => run({ keepLocalPrinters: v === AS_OU ? null : v === "keep" })}
        >
          <SelectTrigger id="pc-unmanaged-local" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AS_OU}>
              As the OU says ({ou.keepLocal ? "keep" : "remove"}, {ou.keepLocalFrom})
            </SelectItem>
            <SelectItem value="keep">Keep</SelectItem>
            <SelectItem value="remove">Remove</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
