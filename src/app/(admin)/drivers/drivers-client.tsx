"use client";

import { Trash2Icon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { deleteDriverPackage } from "../actions";

interface UploadResponse {
  ok?: boolean;
  error?: string;
  name?: string;
  drivers?: string[];
  notes?: string[];
  duplicateOf?: string | null;
}

/** POSTs the zip as the raw body (XHR for upload progress) to /api/admin/drivers. */
function uploadPackage(file: File, query: URLSearchParams, onProgress: (pct: number) => void): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/admin/drivers?${query.toString()}`);
    xhr.setRequestHeader("Content-Type", "application/zip");
    xhr.setRequestHeader("X-Spoolfree-Upload", "1");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as UploadResponse;
        resolve(xhr.status >= 200 && xhr.status < 300 ? body : { error: body.error ?? `HTTP ${xhr.status}` });
      } catch {
        resolve({ error: `HTTP ${xhr.status}` });
      }
    };
    xhr.onerror = () => reject(new Error("upload failed (network)"));
    xhr.send(file);
  });
}

export function UploadDriverDialog({ maxMb }: { maxMb: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [universal, setUniversal] = useState(false);
  const [universalDriver, setUniversalDriver] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;

  const reset = () => {
    setFile(null);
    setName("");
    setUniversal(false);
    setUniversalDriver("");
    setProgress(null);
    setError(null);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError("Choose a zip file");
    if (file.size > maxMb * 1024 * 1024) return setError(`The file is larger than ${maxMb} MB`);
    setError(null);
    setProgress(0);
    const q = new URLSearchParams({ name: name.trim(), fileName: file.name });
    if (universal) {
      q.set("universal", "1");
      if (universalDriver.trim()) q.set("universalDriver", universalDriver.trim());
    }
    try {
      const r = await uploadPackage(file, q, setProgress);
      if (!r.ok) {
        setError(r.error ?? "Upload failed");
        setProgress(null);
        return;
      }
      toast.success(`Uploaded ${r.name}: ${r.drivers?.length ?? 0} driver(s)${r.duplicateOf ? ` (same file as ${r.duplicateOf})` : ""}`);
      setOpen(false);
      reset();
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (!o) reset();
        setOpen(o);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <UploadIcon data-icon="inline-start" /> Upload driver
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Upload a driver package</DialogTitle>
            <DialogDescription>
              A zip of a signed Windows x64 printer driver: the INF, its catalog (.cat) and the driver files, as extracted from the vendor&apos;s
              download. Do not upload installers. Up to {maxMb} MB.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="pkgName">Name</FieldLabel>
              <Input id="pkgName" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Brother HL-3150CDN" disabled={busy} />
            </Field>
            <Field>
              <FieldLabel htmlFor="pkgFile">Zip file</FieldLabel>
              <Input
                id="pkgFile"
                type="file"
                accept=".zip,application/zip"
                required
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f && !name) setName(f.name.replace(/\.zip$/i, ""));
                }}
              />
            </Field>
            <Field orientation="horizontal">
              <Switch id="pkgUniversal" checked={universal} onCheckedChange={setUniversal} disabled={busy} />
              <FieldLabel htmlFor="pkgUniversal">Brand universal driver</FieldLabel>
            </Field>
            {universal && (
              <Field>
                <FieldLabel htmlFor="pkgUniversalDriver">Driver to use</FieldLabel>
                <Input
                  id="pkgUniversalDriver"
                  value={universalDriver}
                  onChange={(e) => setUniversalDriver(e.target.value)}
                  placeholder="Empty = the first driver in the INF"
                  disabled={busy}
                />
                <FieldDescription>Auto mode uses it for printers of the package&apos;s manufacturer that no exact-model package covers.</FieldDescription>
              </Field>
            )}
            {busy && (
              <Field>
                <Progress value={progress ?? 0} aria-label="Upload progress" />
                <FieldDescription>{progress === 100 ? "Checking the package…" : `Uploading… ${progress}%`}</FieldDescription>
              </Field>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !file || !name.trim()}>
              {busy ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeletePackageButton({ id, name, inUse }: { id: string; name: string; inUse: string[] }) {
  const [pending, start] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${name}`} disabled={pending}>
          <Trash2Icon />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse.length
              ? `In use by ${inUse.join(", ")}. Printers set to this package manually block the delete; printers in auto mode match another package or go back to driverless at the next sync. Drivers already installed on PCs stay installed.`
              : "No printer uses it. Drivers already installed on PCs stay installed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              start(async () => {
                const r = await deleteDriverPackage(id);
                if (r.ok) toast.success(r.message ?? `Deleted ${name}`);
                else toast.error(r.error);
              })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
