/**
 * node --import tsx scripts/filters-check.ts [outDir]
 * Browser check of search and filters on the list pages at 390px (phone) and 1440px (desktop), light and dark.
 * Needs a running dev instance with DEV_FAKE_AD=1 and DEV_LOGIN=1, seeded with `seed:dev` (SCREENSHOT_BASE_URL,
 * default http://localhost:3000). Read-only: it changes no data.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, expect, type Locator, type Page } from "@playwright/test";

const base = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const out = path.resolve(process.argv[2] ?? "screenshots/filters");
mkdirSync(out, { recursive: true });

async function minTarget(l: Locator, what: string) {
  const box = await l.boundingBox();
  if (!box) throw new Error(`${what}: not visible`);
  if (box.height < 43.5) throw new Error(`${what}: ${box.width}x${box.height}, under 44px`);
}

async function noHorizontalScroll(page: Page, what: string) {
  const [sw, vw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > vw + 1) throw new Error(`${what}: horizontal scroll (${sw}px > ${vw}px)`);
}

const count = (page: Page) => page.getByTestId("result-count");

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
}

async function run(width: number, height: number, label: string, mobile: boolean, scheme: "light" | "dark") {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: mobile, isMobile: mobile, colorScheme: scheme });
  const page = await ctx.newPage();
  const shot = (name: string) => page.screenshot({ path: path.join(out, `${label}-${name}.png`) });
  try {
    await page.goto(`${base}/login`);
    await page.getByRole("button", { name: /Development login/ }).click();
    await page.waitForURL(`${base}/`);
    // Light/dark comes from the system setting (next-themes "system").
    await page.evaluate((s) => localStorage.setItem("theme", s), scheme);

    // ---- Printers: search is debounced into ?q=, survives a reload, back button restores ----
    await page.goto(`${base}/printers`);
    await expect(count(page)).toHaveText(/^\d+ printers$/);
    const total = Number((await count(page).textContent())!.split(" ")[0]);
    const search = page.getByRole("searchbox", { name: "Search printers" });
    if (mobile) await minTarget(search.locator("xpath=.."), "printer search box");
    await search.fill("finance");
    await page.waitForURL(/[?&]q=finance/);
    await expect(count(page)).toHaveText(`1 of ${total} printers`);
    await page.reload();
    await expect(page.getByRole("searchbox", { name: "Search printers" })).toHaveValue("finance");
    await expect(count(page)).toHaveText(`1 of ${total} printers`);
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await page.waitForURL(`${base}/printers`);
    await expect(count(page)).toHaveText(`${total} printers`);

    // Brand filter + sort; on phones inside the Filters sheet with an active-filter badge.
    if (mobile) {
      const open = page.getByRole("button", { name: /^Filters/ });
      await minTarget(open, "Filters button");
      await open.click();
      const sheet = page.getByRole("dialog", { name: "Filters" });
      await sheet.getByRole("radio", { name: "Offline" }).click();
      await page.waitForURL(/status=offline/);
      await sheet.getByRole("switch", { name: "Unassigned" }).click();
      await page.waitForURL(/unassigned=1/);
      await sheet.getByRole("switch", { name: "Unassigned" }).click();
      await page.waitForURL((u) => !u.search.includes("unassigned"));
      await settle(page);
      await shot("printers-filters-sheet");
      await sheet.getByRole("button", { name: /^Show/ }).click();
      await expect(page.getByRole("button", { name: "Filters (1 active)" })).toBeVisible();
    } else {
      await page.getByRole("radio", { name: "Offline" }).click();
      await page.waitForURL(/status=offline/);
      await settle(page);
      await page.getByRole("combobox", { name: "Sort" }).click();
      await page.getByRole("option", { name: "Status (problems first)" }).click();
      await page.waitForURL(/sort=status/);
    }
    await expect(count(page)).toHaveText(new RegExp(`^\\d+ of ${total} printers$`));
    await settle(page);
    await noHorizontalScroll(page, "printers");
    await shot("printers-filtered");
    await page.goBack();
    await page.waitForURL((u) => !u.search.includes("sort=status") || !u.search.includes("status=offline"));

    // A search with no match shows the empty state with Clear filters.
    await page.goto(`${base}/printers?q=zzzz-no-such-printer`);
    await expect(page.getByText("No printers match")).toBeVisible();

    // ---- Agents: server-side search and state filter ----
    await page.goto(`${base}/agents?state=stale`);
    await expect(count(page)).toHaveText(/ of \d+ PCs$/);
    await page.getByRole("searchbox", { name: "Search agents" }).fill("HR");
    await page.waitForURL(/q=HR/);
    await settle(page);
    await noHorizontalScroll(page, "agents");
    await page.goto(`${base}/agents`);
    await settle(page);
    await shot("agents");

    // ---- Audit log: action family filter ----
    await page.goto(`${base}/audit?action=printer.*`);
    await expect(count(page)).toHaveText(/ of \d+ changes$|^\d+ changes$/);
    await settle(page);
    await noHorizontalScroll(page, "audit");
    await shot("audit");

    // ---- Assignments: OUs that get a printer ----
    await page.goto(`${base}/assignments?assigned=1`);
    await expect(count(page)).toHaveText(/ of \d+ OUs$/);
    await settle(page);
    await noHorizontalScroll(page, "assignments");
    await shot("assignments");

    // ---- Unassigned PCs and analytics search ----
    await page.goto(`${base}/unassigned`);
    await settle(page);
    await noHorizontalScroll(page, "unassigned");
    await page.goto(`${base}/analytics?q=a`);
    await expect(count(page)).toHaveText(/jobs?$/);
    await settle(page);
    await noHorizontalScroll(page, "analytics");
    await shot("analytics");
    console.log(`${label}: ok`);
  } finally {
    await browser.close();
  }
}

async function main() {
  await run(390, 844, "390-light", true, "light");
  await run(390, 844, "390-dark", true, "dark");
  await run(1440, 900, "1440-light", false, "light");
  await run(1440, 900, "1440-dark", false, "dark");
  console.log(`Screenshots written to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
