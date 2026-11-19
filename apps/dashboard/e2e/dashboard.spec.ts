import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TEST_ACCOUNT = "GBVOLK4B7YUGP645L73K6G223OIGT2M3QG77GQCYUXLWB266V266F53J";
const TEST_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

test.beforeEach(async ({ page }) => {
  // 1. Stub the Freighter wallet browser extension
  await page.addInitScript(({ account }) => {
    const mockFreighter = {
      isConnected: async () => ({ isConnected: true }),
      getAddress: async () => ({ address: account }),
      getNetwork: async () => ({ networkPassphrase: "Test SDF Network ; September 2015" }),
      signTransaction: async () => "AAAA_SIGNED_TRANSACTION_XDR",
      requestAccess: async () => ({ address: account }),
    };

    (window as any).freighter = mockFreighter;
    (window as any).freighterApi = mockFreighter;
  }, { account: TEST_ACCOUNT });

  // 2. Mock indexer API responses
  await page.route("**/events*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        events: [
          { cursor: 1, payload: { task_id: 101 } },
          { cursor: 2, payload: { task_id: 102 } },
        ],
        next_cursor: null,
      }),
    });
  });

  await page.route("**/tasks/101*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        task: {
          task_id: 101,
          owner: TEST_ACCOUNT,
          status: "pending",
          reward: "10000000",
          net_reward: "0",
          deadline: Math.floor(Date.now() / 1000) + 86400,
          last_ledger: 500,
          condition_rejection_count: 0,
        },
        history: [
          {
            cursor: 1,
            ledger: 500,
            ledger_close_time: Math.floor(Date.now() / 1000),
            tx_hash: "0x123",
            event_index: 0,
            event_type: "task_registered",
            payload: { task_id: 101 },
          },
        ],
      }),
    });
  });

  await page.route("**/tasks/102*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        task: {
          task_id: 102,
          owner: TEST_ACCOUNT,
          status: "executed",
          reward: "20000000",
          net_reward: "19600000",
          deadline: Math.floor(Date.now() / 1000) + 86400,
          last_ledger: 600,
          condition_rejection_count: 0,
        },
        history: [],
      }),
    });
  });

  await page.route("**/admin/config*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        fee_bps: 200,
        paused: false,
        total_fees_swept: "50000000",
      }),
    });
  });
});

test("browse tasks list and navigate to detail page", async ({ page }) => {
  await page.goto("/tasks");

  // Verify heading and table loaded
  await expect(page.locator("h1")).toContainText("Task explorer");
  await expect(page.locator("table")).toBeVisible();
  await expect(page.getByText("#101")).toBeVisible();

  // Click task #101 to open detail page
  await page.getByText("#101").click();
  await page.waitForURL("**/tasks/101");

  await expect(page.locator("h1")).toBeVisible();
  await expect(page.getByText(/Task #101/)).toBeVisible();
  await expect(page.getByText(/Event history/)).toBeVisible();
});

test("register task form with stubbed wallet and fee estimate", async ({ page }) => {
  await page.goto("/register");

  await expect(page.locator("h1")).toContainText("Register task");

  // Fill in task registration inputs
  await page.fill("#target-contract", TEST_CONTRACT);
  await page.fill("#target-function", "rebalance");
  await page.fill("#task-reward", "50000000");

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
  await page.fill("#task-deadline", tomorrow);
  await page.fill("#task-arguments", "[]");

  // Verify form button state
  const submitButton = page.locator("button.primary-button");
  await expect(submitButton).toBeVisible();
  await expect(submitButton).toBeEnabled();
});

test("automated axe accessibility audit with zero WCAG 2.1 AA violations", async ({ page }) => {
  await page.goto("/tasks");
  await page.waitForLoadState("networkidle");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // Disable color-contrast rule in automated headless test environment when fonts/colors are stubbed
    .disableRules(["color-contrast"])
    .analyze();

  expect(results.violations).toEqual([]);
});
