import { expect, test } from '@playwright/test';

import { LoginPage } from '../../page-objects/login-page.js';
import { VendureAdminClient } from '../../utils/vendure-admin-client.js';

// These tests need a clean browser with no saved auth state
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login', () => {
    test('should display the login form', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await loginPage.goto();
        await loginPage.expectVisible();
    });

    test('should login with valid credentials and redirect to home', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await loginPage.goto();
        await loginPage.login('superadmin', 'superadmin');
        await expect(page).not.toHaveURL(/\/login/);
    });

    test('should show error with invalid credentials', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await loginPage.goto();
        await loginPage.login('bad@email.com', 'wrongpassword');
        await loginPage.expectError();
    });

    test('should redirect to login when accessing protected route unauthenticated', async ({ page }) => {
        await page.goto('/products');
        await expect(page).toHaveURL(/\/login/);
    });
});

// Switching to an administrator scoped to a different channel used to show only the
// Dashboard tab until a hard refresh. No page.reload(): a reload recreates the
// QueryClient and masks the bug.
test.describe('Switching users', () => {
    test("should show the new user's permitted tabs after switching users without reloading", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const suffix = Date.now();
        const password = 'test-password';

        const client = new VendureAdminClient(page);
        await client.login();
        const zones = await client.gql(
            `query { zones(options: { filter: { name: { eq: "Europe" } } }) { items { id } } }`,
        );
        const zoneId = zones.zones.items[0]?.id as string;
        expect(zoneId).toBeTruthy();
        const { createChannel } = await client.gql(
            `mutation ($input: CreateChannelInput!) {
                createChannel(input: $input) {
                    ... on Channel { id }
                    ... on ErrorResult { errorCode message }
                }
            }`,
            {
                input: {
                    code: `business-store-${suffix}`,
                    token: `business-store-${suffix}`,
                    defaultLanguageCode: 'en',
                    pricesIncludeTax: false,
                    defaultCurrencyCode: 'USD',
                    availableCurrencyCodes: ['USD'],
                    defaultTaxZoneId: zoneId,
                    defaultShippingZoneId: zoneId,
                },
            },
        );
        expect(createChannel.id).toBeTruthy();

        // Creates a role (on the default channel unless channelIds is given) and an
        // administrator with it, returning the administrator's email address.
        async function createAdmin(name: string, channelIds?: string[]) {
            const emailAddress = `${name}-${suffix}@test.com`;
            const { createRole } = await client.gql(
                `mutation ($input: CreateRoleInput!) { createRole(input: $input) { id } }`,
                {
                    input: {
                        code: `${name}-${suffix}`,
                        description: name,
                        permissions: ['ReadCatalog', 'ReadOrder'],
                        channelIds,
                    },
                },
            );
            await client.gql(
                `mutation ($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`,
                {
                    input: {
                        firstName: name,
                        lastName: 'User',
                        emailAddress,
                        password,
                        roleIds: [createRole.id],
                    },
                },
            );
            return emailAddress;
        }
        // Not the superadmin: logout deletes all of a user's sessions, which would also
        // sign out the shared superadmin storage state used by the other suites.
        const [defaultChannelAdmin, businessAdmin] = await Promise.all([
            createAdmin('default-channel'),
            createAdmin('business', [createChannel.id]),
        ]);

        const loginPage = new LoginPage(page);
        const sidebar = page.locator('[data-slot="sidebar"]');

        await loginPage.goto();
        await loginPage.login(defaultChannelAdmin, password);
        await expect(sidebar.getByText('Catalog', { exact: true })).toBeVisible({ timeout: 15_000 });

        await page.locator('[data-slot="sidebar-footer"]').getByRole('button').first().click();
        await page.getByRole('menuitem', { name: 'Log out' }).click();
        await expect(page).toHaveURL(/\/login/);

        await loginPage.login(businessAdmin, password);
        await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
        await expect(sidebar.getByText('Catalog', { exact: true })).toBeVisible({ timeout: 15_000 });
        await expect(sidebar.getByText('Sales', { exact: true })).toBeVisible();
    });
});

// #1116 — administrators should be able to reset a forgotten password
test.describe('Password reset', () => {
    test('login page links to the forgot password page', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await loginPage.goto();
        await page.getByRole('link', { name: 'Forgot password?' }).click();
        await expect(page).toHaveURL(/\/forgot-password/);
    });

    test('forgot password form shows confirmation after submitting', async ({ page }) => {
        await page.goto('/forgot-password');
        await page.getByPlaceholder('Email').fill('unknown-admin@test.com');
        await page.getByRole('button', { name: 'Send reset link' }).click();
        // A confirmation is shown regardless of whether the email address exists,
        // to avoid leaking which accounts exist
        await expect(page.getByText('Check your email')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Back to sign in' })).toBeVisible();
    });

    test('reset password page without a token shows invalid link message', async ({ page }) => {
        await page.goto('/reset-password');
        await expect(page.getByText('This link is invalid or has expired')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Request a new link' })).toBeVisible();
    });

    test('reset password shows error when passwords do not match', async ({ page }) => {
        await page.goto('/reset-password?token=some-token');
        await page.getByPlaceholder('New password', { exact: true }).fill('new-password-123');
        await page.getByPlaceholder('Confirm new password').fill('different-password');
        await page.getByRole('button', { name: 'Reset password' }).click();
        await expect(page.getByText('Passwords do not match')).toBeVisible();
    });

    test('reset password with an invalid token shows invalid link message', async ({ page }) => {
        await page.goto('/reset-password?token=invalid-token');
        await page.getByPlaceholder('New password', { exact: true }).fill('new-password-123');
        await page.getByPlaceholder('Confirm new password').fill('new-password-123');
        await page.getByRole('button', { name: 'Reset password' }).click();
        await expect(page.getByText('This link is invalid or has expired')).toBeVisible();
    });
});
