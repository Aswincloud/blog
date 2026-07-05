/**
 * @file e2e/smoke.spec.js
 * @copyright © 2025 Aswin. All rights reserved.
 * @author Aswin
 * @description End-to-end (Playwright) smoke tests for the Hugo blog.
 */
import { test, expect } from '@playwright/test';

test('homepage renders with title and Posts nav', async ({ page }) => {
  const resp = await page.goto('/');
  expect(resp?.ok()).toBeTruthy();
  await expect(page).toHaveTitle(/Homelab/i);
  await expect(page.getByRole('link', { name: /posts/i }).first()).toBeVisible();
});

test('Posts section is reachable and lists content', async ({ page }) => {
  const resp = await page.goto('/posts/');
  expect(resp?.ok()).toBeTruthy();
  // A real heading renders on the posts list (not a blank/404 page).
  await expect(page.getByRole('heading').first()).toBeVisible();
});
