/**
 * node --import tsx scripts/pc-picker-check.ts [outDir]
 * Browser check of the Add/Edit printer form at 390px (phone) and 1440px (desktop): the clean main section, the
 * collapsed "Advanced (migration)" section, the "Assign to specific PCs" picker and the combined "Will reach N" count.
 * Needs a running dev instance with DEV_FAKE_AD=1 and DEV_LOGIN=1 (SCREENSHOT_BASE_URL, default http://localhost:3000).
 * Creates a printer per viewport, edits its PCs, checks Preview, then deletes it.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, expect, type Locator, type Page } from "@playwright/test";

const base = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const out = path.resolve(process.argv[2] ?? "screenshots/pc-picker");
mkdirSync(out, { recursive: true });

async function minTarget(l: Locator, what: string) {
  const box = await l.boundingBox();
  if (!box) throw new Error(`${what}: not visible`);
  if (box.height < 43.5 || box.width < 43.5) throw new Error(`${what}: ${box.width}x${box.height}, under 44px`);
}

/** Pick items in a picker (bottom sheet on phones, popover on desktop). */
async function pick(page: Page, dialog: Locator, label: string, search: string, items: RegExp[], mobile: boolean, shot?: string) {
  const trigger = dialog.getByRole("combobox", { name: label });
  if (mobile) await minTarget(trigger, `${label} trigger`);
  await trigger.click();
  const scope = mobile ? page.getByRole("dialog", { name: label }) : page.locator("[data-slot=popover-content]");
  const input = scope.getByPlaceholder(search);
  for (const item of items) {
    await input.fill(item.source.replace(/[\\^$]/g, ""));
    const option = scope.getByRole("option", { name: item });
    if (mobile) await minTarget(option, `${label} option`);
    await option.click();
  }
  await input.fill("");
  await page.waitForTimeout(400);
  if (shot) await page.screenshot({ path: shot });
  if (mobile) {
    await scope.getByRole("button", { name: /^Done/ }).click();
    await scope.waitFor({ state: "detached" });
  } else {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  }
}

async function run(width: number, height: number, label: string, mobile: boolean) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: mobile, isMobile: mobile });
  const page = await ctx.newPage();
  const name = `PC picker check ${label}`;
  const rowOf = () => (mobile ? page.locator("[data-slot=item]").filter({ hasText: name }) : page.locator("tbody tr").filter({ hasText: name }));
  try {
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /Development login/ }).click();
    await page.waitForURL(`${base}/`);
    await page.goto(`${base}/printers`);

    // ---- Add printer: clean main section, migration settings collapsed ----
    await page.getByRole("button", { name: "Add printer" }).click();
    const dialog = page.getByRole("dialog", { name: "Add printer" });
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByLabel("IP address or hostname").fill("192.0.2.201");
    await expect(dialog.getByLabel("Replace existing queues for this device")).toBeHidden();
    await expect(dialog.getByLabel("Legacy hostnames / aliases")).toBeHidden();
    await expect(dialog.getByText("Shares on the old print servers")).toHaveCount(0);
    await expect(dialog.getByLabel("IPP path override", { exact: true })).toBeHidden();
    await page.screenshot({ path: path.join(out, `${label}-1-add-form.png`) });

    // A fixed IPP path keeps the save fast (no detection against a test address).
    await dialog.getByRole("button", { name: /Connection and notes/ }).click();
    await dialog.getByLabel("IPP path override", { exact: true }).fill("/ipp/print");

    await pick(page, dialog, "Assign to OUs", "Search OUs…", [/Finance/], mobile);
    await pick(page, dialog, "Assign to specific PCs", "Search PCs…", [/LAB-01/, /FIN-01/], mobile, path.join(out, `${label}-2-pc-picker-open.png`));

    const selected = dialog.getByRole("list", { name: "Selected PCs" });
    await expect(selected.getByRole("listitem")).toHaveCount(2);
    // Finance has FIN-01 and FIN-02; LAB-01 adds one; FIN-01 is counted once.
    await expect(dialog.getByText(/Will reach 3 computers/)).toBeVisible();
    if (mobile) await minTarget(selected.getByRole("button", { name: "Remove LAB-01" }), "remove PC");

    // The migration section opens and shows the server default (on).
    await dialog.getByRole("button", { name: /Advanced \(migration\)/ }).click();
    await expect(dialog.getByRole("combobox", { name: "Replace existing queues for this device" })).toContainText("On:");
    await selected.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `${label}-3-selected.png`) });
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Printer added\. 1 OU added, 2 PCs added/)).toBeVisible();
    await expect(dialog).toBeHidden();

    // ---- Edit: shows the stored PCs; remove FIN-01 (still reached through Finance) ----
    await rowOf().getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: `Edit ${name}` });
    const editList = edit.getByRole("list", { name: "Selected PCs" });
    await expect(editList.getByRole("listitem")).toHaveCount(2);
    await editList.getByRole("button", { name: "Remove FIN-01" }).click();
    await expect(editList.getByRole("listitem")).toHaveCount(1);
    await expect(edit.getByText(/Will reach 3 computers/)).toBeVisible();
    await editList.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `${label}-4-edit.png`) });
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Printer updated\. 1 PC removed/)).toBeVisible();

    // No horizontal scroll on the printers page.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) throw new Error(`horizontal overflow ${overflow}px`);
  } finally {
    await page.goto(`${base}/printers`).catch(() => undefined);
    if (await rowOf().count()) {
      await rowOf().getByRole("button", { name: `Actions for ${name}` }).click();
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
