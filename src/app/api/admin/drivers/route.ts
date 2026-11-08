import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { driverNames } from "@/lib/drivers/package";
import { ingestDriverPackage, receiveToTempFile, UploadTooLargeError } from "@/lib/drivers/store";

/**
 * Driver package upload from the Drivers page: the raw zip as the request body (streamed to a temporary file, not
 * held in memory), the package name and options in the query string. Admin session only; the custom header forces a
 * CORS preflight, so other sites cannot post here with the admin's cookie.
 *
 *   POST /api/admin/drivers?name=<name>&fileName=<file>&universal=1&universalDriver=<driver>
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || !session.isAdmin) return NextResponse.json({ error: "not signed in as an admin" }, { status: 401 });
  if (req.headers.get("x-spoolfree-upload") !== "1") return NextResponse.json({ error: "missing upload header" }, { status: 400 });
  const url = new URL(req.url);
  const name = url.searchParams.get("name") ?? "";
  const maxBytes = config().DRIVER_PACKAGE_MAX_MB * 1024 * 1024;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return NextResponse.json({ error: `the package is larger than ${config().DRIVER_PACKAGE_MAX_MB} MB` }, { status: 413 });
  if (!req.body) return NextResponse.json({ error: "empty body" }, { status: 400 });
  let file;
  try {
    file = await receiveToTempFile(Readable.fromWeb(req.body as import("node:stream/web").ReadableStream<Uint8Array>), maxBytes);
  } catch (e) {
    if (e instanceof UploadTooLargeError) return NextResponse.json({ error: e.message }, { status: 413 });
    throw e;
  }
  const actor = session.user.email ?? (session.authMethod === "local" ? "local" : "unknown");
  const r = await ingestDriverPackage(db(), {
    name,
    file,
    fileName: url.searchParams.get("fileName"),
    uploadedBy: actor,
    universal: url.searchParams.get("universal") === "1",
    universalDriver: url.searchParams.get("universalDriver"),
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  for (const p of ["/drivers", "/printers"]) revalidatePath(p);
  return NextResponse.json({
    ok: true,
    id: r.package.id,
    name: r.package.name,
    sha256: r.package.sha256,
    size: r.package.size,
    drivers: driverNames(r.package.infs),
    notes: r.inspection.notes,
    duplicateOf: r.duplicateOf,
  });
}
