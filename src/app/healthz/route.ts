import { NextResponse } from "next/server";
import { sqlClient } from "@/lib/db";

export async function GET() {
  try {
    await sqlClient()`select 1`;
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "error", db: "unreachable" }, { status: 503 });
  }
}
