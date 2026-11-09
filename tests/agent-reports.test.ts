import { describe, expect, it, vi } from "vitest";
import { vendorFallbackByQueue } from "@/lib/agent-reports";

vi.mock("@/lib/db", () => ({ db: () => null, schema: {}, sqlClient: () => null }));

describe("vendor fallback per PC (Printers page)", () => {
  it("lists the PCs whose queue for a printer is on the vendor fallback, ignoring revoked agents", () => {
    const m = vendorFallbackByQueue([
      { computerName: "PC-02", lastReport: { queues: [{ name: "Finance Laser", method: "Vendor", vendorFallback: "Brother HL-L5100DN" }] } },
      { computerName: "PC-01", lastReport: { queues: [{ name: "finance laser", method: "Vendor", vendorFallback: "Brother HL-L5100DN" }, { name: "Other", method: "IppUrl", vendorFallback: null }] } },
      { computerName: "PC-03", lastReport: { queues: [{ name: "Finance Laser", method: "IppUrl" }] } },
      { computerName: "PC-OLD", lastReport: { queues: [{ name: "Finance Laser", method: "Vendor", vendorFallback: "x" }] }, revokedAt: new Date() },
      { computerName: "PC-NEW", lastReport: null },
    ]);
    expect([...m.entries()]).toEqual([["finance laser", ["PC-01", "PC-02"]]]);
  });
});

describe("poller housekeeping (L7)", () => {
  it("expires test prints on every cycle, and a failure of one step does not stop the other", async () => {
    const { runHousekeeping } = await import("@/lib/status/poller");
    const expire = vi.fn(async () => 2);
    await runHousekeeping({ purge: async () => { throw new Error("purge down"); }, expire });
    expect(expire).toHaveBeenCalledTimes(1);
    await expect(runHousekeeping({ purge: async () => {}, expire: async () => { throw new Error("db down"); } })).resolves.toBeUndefined();
  });
});
