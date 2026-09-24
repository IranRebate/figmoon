import { test, expect } from '@playwright/test';

test('comp-message-actions', async ({ page }) => {
  await page.setContent('<div id="fixture">message-actions</div>');
  await expect(page.locator('#fixture')).toHaveText('message-actions');
});
