/**
 * pnpm screenshots [outDir]
 * Captures the main screens from a running dev instance (DEV_FAKE_AD=1, DEV_LOGIN=1,
 * seeded with `pnpm seed:dev` and `pnpm dev:printers` running).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const base = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const out = path.resolve(process.argv[2] ?? "screenshots");
mkdirSync(out, { recursive: true });

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  await page.goto(`${base}/login`);
  await page.getByRole("button", { name: /Development login/ }).click();
  await page.waitForURL(`${base}/`);

  // Run the IPP test on simulator-backed printers so the "Driverless" column is filled in.
  await page.goto(`${base}/printers`);
  const rows = page.locator("tbody tr").filter({ hasText: "127.0.0.1" });
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    await rows.nth(i).getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Test (IPP)" }).click();
    await page.getByRole("dialog").waitFor();
    if (i < n - 1) {
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
    }
  }
  await settle(page);
  await page.screenshot({ path: path.join(out, "05-printer-test.png") });
  await page.keyboard.press("Escape");
  await page.reload();
  await settle(page);
  await page.screenshot({ path: path.join(out, "01-printers.png") });

  const ou = "OU=Science Lab,OU=Teaching,OU=Workstations,DC=example,DC=org";
  await page.goto(`${base}/assignments?ou=${encodeURIComponent(ou)}`);
  await page.getByText("Inherited from parent OUs").waitFor();
  await settle(page);
  await page.screenshot({ path: path.join(out, "02-assignments.png"), fullPage: true });

  await page.goto(`${base}/`);
  await page.getByText("Printers online").waitFor();
  await settle(page);
  await page.screenshot({ path: path.join(out, "03-status.png") });

  await page.goto(`${base}/agents`);
  await settle(page);
  await page.screenshot({ path: path.join(out, "04-agents.png") });

  await page.goto(`${base}/preview?computer=${await guidOf(page, "HR-01")}`);
  await page.getByText("How it was resolved").waitFor();
  await settle(page);
  await page.screenshot({ path: path.join(out, "06-preview.png") });

  await browser.close();
  console.log(`Screenshots written to ${out}`);
}

async function settle(page: import("@playwright/test").Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
}

async function guidOf(page: import("@playwright/test").Page, name: string): Promise<string> {
  const { fakeGuid } = await import("../src/lib/directory/fake");
  void page;
  return fakeGuid(name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
