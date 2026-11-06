"use client";

import { MonitorIcon, StarIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { shortDn } from "@/lib/format";
import { assignPrinter, setBlockInheritance, setOuDefault, setPrinterBlocked, unassignPrinter, type ActionResult } from "../actions";

interface Props {
  ou: { dn: string; name: string; kind: string; description: string | null; isRoot: boolean };
  printers: { id: string; name: string; location: string | null }[];
  own: string[];
  inherited: { printerId: string; fromOu: string }[];
  inheritedDefault: string | null;
  blockInheritance: boolean;
  blocked: string[];
  defaultPrinterId: string | null;
  effective: string[];
  effectiveDefault: string | null;
  computers: { name: string; guid: string }[];
  computersBelow: number;
}

const NONE = "__none__";

export function OuPanel(p: Props) {
  const [pending, start] = useTransition();
  const [toAdd, setToAdd] = useState<string>("");
  const byId = new Map(p.printers.map((x) => [x.id, x]));
  const name = (id: string) => byId.get(id)?.name ?? "(deleted)";
  const run = (fn: () => Promise<ActionResult>, ok?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error);
      else if (ok) toast.success(ok);
    });
  const available = p.printers.filter((x) => !p.own.includes(x.id));

  return (
    <div className="flex min-w-0 flex-col gap-4 md:gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{p.ou.kind === "domain" ? "Domain root" : p.ou.name}</CardTitle>
          <CardDescription className="font-mono text-xs break-all">{p.ou.dn}</CardDescription>
          <div className="flex flex-wrap gap-2 pt-1">
            <Badge variant="outline">{p.computers.length} PCs here</Badge>
            <Badge variant="outline">{p.computersBelow} incl. child OUs</Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!p.ou.isRoot && (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="block-inh">Block inheritance</FieldLabel>
                <FieldDescription>Ignore every printer assigned to parent OUs.</FieldDescription>
              </FieldContent>
              <Switch
                id="block-inh"
                checked={p.blockInheritance}
                disabled={pending}
                onCheckedChange={(v) => run(() => setBlockInheritance(p.ou.dn, v))}
              />
            </Field>
          )}
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel htmlFor="ou-default">Default printer</FieldLabel>
              <FieldDescription>
                Set as default on PCs in this OU and below{p.inheritedDefault && !p.defaultPrinterId ? ` (inherits ${name(p.inheritedDefault)})` : ""}.
              </FieldDescription>
            </FieldContent>
            <Select
              value={p.defaultPrinterId ?? NONE}
              disabled={pending}
              onValueChange={(v) => run(() => setOuDefault(p.ou.dn, v === NONE ? null : v))}
            >
              <SelectTrigger id="ou-default" className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not set here</SelectItem>
                {p.effective.map((id) => (
                  <SelectItem key={id} value={id}>
                    {name(id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assigned here</CardTitle>
          <CardDescription>Applies to computers in this OU and every child OU.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={toAdd} onValueChange={setToAdd}>
              <SelectTrigger className="w-full sm:w-56" aria-label="Printer to assign">
                <SelectValue placeholder="Choose a printer" />
              </SelectTrigger>
              <SelectContent>
                {available.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={!toAdd || pending}
              onClick={() => {
                const id = toAdd;
                setToAdd("");
                run(() => assignPrinter(p.ou.dn, id), `Assigned ${name(id)}`);
              }}
            >
              Assign
            </Button>
          </div>
          {p.own.length === 0 ? (
            <p className="text-sm text-muted-foreground">No printers assigned directly to this OU.</p>
          ) : (
            <Table>
              <TableBody>
                {p.own.map((id) => (
                  <TableRow key={id}>
                    <TableCell className="font-medium whitespace-normal">
                      {name(id)}
                      {p.effectiveDefault === id && (
                        <Badge variant="secondary" className="ml-2">
                          <StarIcon data-icon="inline-start" /> Default
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{byId.get(id)?.location ?? ""}</TableCell>
                    <TableCell className="w-10 text-right">
                      <Button variant="ghost" size="icon-sm" aria-label={`Unassign ${name(id)}`} disabled={pending} onClick={() => run(() => unassignPrinter(p.ou.dn, id))}>
                        <XIcon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {!p.ou.isRoot && (
        <Card>
          <CardHeader>
            <CardTitle>Inherited from parent OUs</CardTitle>
            <CardDescription>
              {p.blockInheritance ? "Inheritance is blocked for this OU." : "Switch a printer off to block it here and below."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {p.inherited.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is inherited.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Printer</TableHead>
                    <TableHead className="hidden sm:table-cell">From</TableHead>
                    <TableHead className="text-right">Applies</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.inherited.map((r) => {
                    const isBlocked = p.blocked.includes(r.printerId);
                    return (
                      <TableRow key={r.printerId} className={p.blockInheritance ? "opacity-50" : undefined}>
                        <TableCell className="font-medium whitespace-normal">
                          {name(r.printerId)}
                          <div className="text-xs font-normal text-muted-foreground sm:hidden">from {shortDn(r.fromOu) || "Domain root"}</div>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">{shortDn(r.fromOu) || "Domain root"}</TableCell>
                        <TableCell className="text-right">
                          <Switch
                            aria-label={`Apply ${name(r.printerId)} here`}
                            checked={!isBlocked && !p.blockInheritance}
                            disabled={pending || p.blockInheritance}
                            onCheckedChange={(v) => run(() => setPrinterBlocked(p.ou.dn, r.printerId, !v))}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Computers in this OU</CardTitle>
          <CardDescription>
            Each gets {p.effective.length === 0 ? "no printers" : p.effective.map(name).join(", ")} before per-computer overrides.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {p.computers.length === 0 && <p className="text-sm text-muted-foreground">No computer objects directly in this OU.</p>}
          {p.computers.map((c) => (
            <Button key={c.guid} variant="outline" size="sm" asChild>
              <Link href={`/preview?computer=${c.guid}`}>
                <MonitorIcon data-icon="inline-start" />
                {c.name}
              </Link>
            </Button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
