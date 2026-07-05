import { test, expect } from '@playwright/test';

test('homepage renders with title and Posts nav', async ({ page }) => {
  const resp = await page.goto('/');
  expect(resp?.ok()).toBeTruthy();
  await expect(page).toHaveTitle(/Homelab/i);
  // Menu defined in hugo.toml: Posts + About.
  await expect(page.getByRole('link', { name: /posts/i }).first()).toBeVisible();
});

test('Posts section is reachable', async ({ page }) => {
  const resp = await page.goto('/posts/');
  expect(resp?.ok()).toBeTruthy();
  await expect(page.locator('body')).not.toBeEmpty();
});
