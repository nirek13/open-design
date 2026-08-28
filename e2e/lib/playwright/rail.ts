import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Destinations live in the slim left sidebar. This helper waits until
 * that rail is interactable. Call it before clicking any `entry-nav-*`
 * item that is already pinned on the dock.
 */
export async function ensureRailOpen(page: Page): Promise<void> {
  await expect(page.getByTestId('entry-nav-logo')).toBeVisible();
  await expect(page.getByTestId('entry-nav-home')).toBeVisible();
}

const NAV_TEST_ID_PREFIX = 'entry-nav-';

/** Open a destination from the sidebar, or from Places if it is not pinned. */
export async function clickEntryNav(page: Page, testId: string): Promise<void> {
  await ensureRailOpen(page);
  const onDock = page.getByTestId('entry-nav-dock').getByTestId(testId);
  if (await onDock.isVisible().catch(() => false)) {
    await onDock.click();
    return;
  }
  const id = testId.startsWith(NAV_TEST_ID_PREFIX)
    ? testId.slice(NAV_TEST_ID_PREFIX.length)
    : testId;
  await page.getByTestId('entry-nav-logo').click();
  await expect(page.getByTestId('entry-nav-atlas')).toBeVisible();
  await page.getByTestId(`entry-nav-atlas-${id}`).click();
}

export async function openNewProjectModal(page: Page): Promise<void> {
  if (await page.getByTestId('new-project-panel').isVisible().catch(() => false)) return;
  await ensureRailOpen(page);
  const railCreateButton = page.getByTestId('entry-nav-new-project');
  if (await railCreateButton.isVisible().catch(() => false)) {
    const point = await getActionablePoint(railCreateButton);
    if (point) {
      await page.mouse.click(point.x, point.y);
      await expect(page.getByTestId('new-project-modal')).toBeVisible();
      await expect(page.getByTestId('new-project-panel')).toBeVisible();
      return;
    }
  }

  const projectsNav = page.getByTestId('entry-nav-projects');
  if (await projectsNav.isVisible().catch(() => false)) {
    await projectsNav.scrollIntoViewIfNeeded();
    await projectsNav.click();
  } else if (!/\/projects$/.test(new URL(page.url()).pathname)) {
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
  }
  const projectsView = page.getByTestId('entry-view-projects');
  await expect(projectsView).toBeVisible();
  const createButton = projectsView
    .getByTestId('designs-new-project')
    .or(projectsView.getByTestId('designs-empty-new-project'))
    .first();
  await expect(createButton).toBeVisible();
  await createButton.click();
  await expect(page.getByTestId('new-project-modal')).toBeVisible();
  await expect(page.getByTestId('new-project-panel')).toBeVisible();
}

async function getActionablePoint(locator: Locator): Promise<{ x: number; y: number } | null> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x > window.innerWidth ||
      point.y > window.innerHeight
    ) {
      return null;
    }
    const hit = document.elementFromPoint(point.x, point.y);
    return hit && element.contains(hit) ? point : null;
  }).catch(() => null);
}
