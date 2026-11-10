import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { AgentAuthError, authenticateAgent } from "@/lib/agent-auth";
import { db, schema } from "@/lib/db";
import { packageChunks } from "@/lib/drivers/store";
import { manifestNamesPackage } from "@/lib/manifest";
import { manifestForComputer } from "@/lib/service";

/**
 * A vendor driver package (agents 0.7+), for enrolled agents only (machine token), and only a package that this
 * computer's manifest names (as a vendor driver or a per-PC vendor fallback). The agent checks the bytes against the SHA-256 and size in its signed manifest and the
 * catalog's Authenticode signature before installing, so this response needs no signature of its own.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { computer } = await authenticateAgent(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const manifest = await manifestForComputer(computer);
    if (!manifestNamesPackage(manifest.printers, id)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const [pkg] = await db().select().from(schema.driverPackages).where(eq(schema.driverPackages.id, id));
    if (!pkg) return NextResponse.json({ error: "not found" }, { status: 404 });
    const it = packageChunks(db(), id);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await it.next();
          if (done) controller.close();
          else controller.enqueue(new Uint8Array(value));
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel() {
        await it.return(undefined);
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(pkg.size),
        "Cache-Control": "no-store",
        "X-Spoolfree-Driver-Sha256": pkg.sha256,
      },
    });
  } catch (e) {
    if (e instanceof AgentAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("driver package error", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
