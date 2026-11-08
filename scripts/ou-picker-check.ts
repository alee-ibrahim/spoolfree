/**
 * node --import tsx scripts/ou-picker-check.ts [outDir]
 * Browser check of the OU picker in the Add/Edit printer form at 390px (phone) and 1440px (desktop).
 * Needs a running dev instance with DEV_FAKE_AD=1 and DEV_LOGIN=1 (SCREENSHOT_BASE_URL, default http://localhost:3000).
 * Creates a printer per viewport, edits its OUs, checks the Assignments page, then deletes it.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, expect, type Locator } from "@playwright/test";

const base = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const out = path.resolve(process.argv[2] ?? "screenshots/ou-picker");
mkdirSync(out, { recursive: true });

const FIN = "OU=Finance,OU=Administration,OU=Workstations,DC=example,DC=org";

async function minTarget(l: Locator, what: string) {
  const box = await l.boundingBox();
  if (!box) throw new Error(`${what}: not visible`);
  // Half a pixel of slack for subpixel layout.
  if (box.height < 43.5 || box.width < 43.5) throw new Error(`${what}: ${box.width}x${box.height}, under 44px`);
}

async function run(width: number, height: number, label: string, mobile: boolean) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: mobile, isMobile: mobile });
  const page = await ctx.newPage();
  const name = `OU picker check ${label}`;
  try {
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /Development login/ }).click();
    await page.waitForURL(`${base}/`);
    await page.goto(`${base}/printers`);

    // ---- Add printer with two OUs, one as default ----
    await page.getByRole("button", { name: "Add printer" }).click();
    const dialog = page.getByRole("dialog", { name: "Add printer" });
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByLabel("IP address or hostname").fill("192.0.2.200");
    await dialog.getByRole("button", { name: /Connection and notes/ }).click();
    await dialog.getByLabel("IPP path override", { exact: true }).fill("/ipp/print");
    const trigger = dialog.getByRole("combobox", { name: "Assign to OUs" });
    if (mobile) await minTarget(trigger, "picker trigger");

    if (mobile) {
      await trigger.click();
      const sheet = page.getByRole("dialog", { name: "Assign to OUs" });
      await sheet.getByPlaceholder("Search OUs…").fill("finance");
      const item = sheet.getByRole("option", { name: /Finance/ });
      await minTarget(item, "OU option");
      await item.click();
      await sheet.getByPlaceholder("Search OUs…").fill("science");
      await sheet.getByRole("option", { name: /Science Lab/ }).click();
      await sheet.getByPlaceholder("Search OUs…").fill("");
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, `${label}-1-picker-open.png`) });
      await sheet.getByRole("button", { name: /^Done/ }).click();
      await sheet.waitFor({ state: "detached" });
    } else {
      // Keyboard only: open, search, pick, search, pick, close.
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.type("admin fin");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Control+A");
      await page.keyboard.type("science");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, `${label}-1-picker-open.png`) });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
    }

    const selected = dialog.getByRole("list", { name: "Selected OUs" });
    await expect(selected.getByRole("listitem")).toHaveCount(2);
    await expect(dialog.getByText(/Will reach \d+ computers?/)).toBeVisible();
    const finRow = selected.getByRole("listitem").filter({ hasText: "Finance" });
    const remove = finRow.getByRole("button", { name: /^Remove/ });
    if (mobile) await minTarget(remove, "remove button");
    await finRow.getByLabel("Default for this OU").click();
    await expect(finRow.getByRole("switch")).toBeChecked();
    await page.waitForTimeout(300);
    await selected.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `${label}-2-selected.png`) });
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Printer added\. 2 OUs added/)).toBeVisible();
    await expect(dialog).toBeHidden();

    // ---- Edit: shows current OUs; remove Science Lab ----
    const scope = mobile ? page.locator("[data-slot=item]").filter({ hasText: name }) : page.locator("tbody tr").filter({ hasText: name });
    await scope.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: `Edit ${name}` });
    const editList = edit.getByRole("list", { name: "Selected OUs" });
    await expect(editList.getByRole("listitem")).toHaveCount(2);
    await expect(editList.getByRole("listitem").filter({ hasText: "Finance" }).getByRole("switch")).toBeChecked();
    await editList.getByRole("listitem").filter({ hasText: "Science Lab" }).getByRole("button", { name: /^Remove/ }).click();
    await expect(editList.getByRole("listitem")).toHaveCount(1);
    await expect(edit.getByText(/Will reach 2 computers/)).toBeVisible();
    await page.screenshot({ path: path.join(out, `${label}-3-edit.png`) });
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Printer updated\. 1 removed/)).toBeVisible();

    // ---- Same data on the Assignments page ----
    await page.goto(`${base}/assignments?ou=${encodeURIComponent(FIN)}`);
    await expect(page.getByText(name).first()).toBeVisible();

    // No horizontal scroll on the printers page.
    await page.goto(`${base}/printers`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) throw new Error(`horizontal overflow ${overflow}px`);
  } finally {
    // Clean up the test printer.
    await page.goto(`${base}/printers`).catch(() => undefined);
    const scope = mobile ? page.locator("[data-slot=item]").filter({ hasText: name }) : page.locator("tbody tr").filter({ hasText: name });
    if (await scope.count()) {
      await scope.getByRole("button", { name: `Actions for ${name}` }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
      await expect(page.getByText(`Deleted ${name}`)).toBeVisible();
    }
    await browser.close();
  }
  console.log(`ok ${label}`);
}

async function main() {
  await run(390, 844, "390", true);
  await run(1440, 900, "1440", false);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
