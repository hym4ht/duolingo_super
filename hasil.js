import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
    await page.locator('[data-test="flag-english language-card"]').click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.getByRole('radio', { name: 'Lainnya' }).click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.locator('[data-test="other"]').click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.getByRole('radio', { name: 'Aku bisa membahas berbagai' }).click();
    await page.getByRole('radio', { name: 'Aku bisa membahas berbagai' }).click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.getByRole('radio', { name: 'mnt / hari Santai' }).click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.locator('[data-test="block-button"]').click();
    await page.getByRole('radio', { name: 'Mulai dari awal Ambil' }).click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.locator('[data-test="funboarding-continue-button"]').click();
    await page.locator('[data-test="quit-button"]').click();
    await page.locator('._1sSQy > img').click();
    await page.locator('[data-test="create-profile-juicy"]').click();
    await page.locator('[data-test="age-input"]').click();
    await page.locator('[data-test="age-input"]').fill('20');
    await page.locator('[data-test="continue-button"]').click();
});