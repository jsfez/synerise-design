import { argosScreenshot } from '@argos-ci/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

/**
 * One Playwright test per Storybook story of the design system.
 *
 * The story list and each story's `chromatic` parameters are read from the
 * static build, so a story that opts out with `chromatic: { disableSnapshot: true }`
 * is skipped here exactly like it is skipped today, a story that asks for a
 * `chromatic: { delay }` gets the same wait before capture, and the regions
 * marked `.chromatic-ignore` are masked rather than compared.
 */

type StoryEntry = {
  id: string;
  title: string;
  name: string;
  type?: string;
};

type ChromaticParameters = {
  disableSnapshot?: boolean;
  disable?: boolean;
  delay?: number;
};

const INDEX_PATH = fileURLToPath(
  new URL('../packages/storybook/storybook-static/index.json', import.meta.url),
);

// Regions the stories already mark as volatile for Chromatic (random counters,
// generated table cells). Masking them keeps the same contract.
const IGNORE_SELECTOR = '.chromatic-ignore';

function readStories(): StoryEntry[] {
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as {
    entries: Record<string, StoryEntry>;
  };

  return Object.values(index.entries).filter(
    (entry) => (entry.type ?? 'story') === 'story',
  );
}

const only = process.env['ARGOS_ONLY'];
const stories = readStories().filter(
  (story) => !only || new RegExp(only).test(story.id),
);

// `title › name` is not guaranteed to be unique, and Playwright refuses two
// tests with the same title at collection time, which would produce an empty
// build. Suffix only the labels that actually collide, so names stay readable.
const labelCount = new Map<string, number>();
for (const story of stories) {
  const label = `${story.title} › ${story.name}`;
  labelCount.set(label, (labelCount.get(label) ?? 0) + 1);
}

function labelFor(story: StoryEntry): string {
  const label = `${story.title} › ${story.name}`;

  return (labelCount.get(label) ?? 0) > 1 ? `${label} (${story.id})` : label;
}

async function waitForPhase(page: Page, id: string): Promise<void> {
  // Storybook 10 exposes the active renders as an array, match by id.
  await page.waitForFunction(
    (storyId) => {
      const preview = (
        window as unknown as {
          __STORYBOOK_PREVIEW__?: {
            storyRenders?: { id: string; phase?: string }[];
          };
        }
      ).__STORYBOOK_PREVIEW__;
      const renders = preview?.storyRenders ?? [];
      const render = renders.find((item) => item.id === storyId) ?? renders[0];

      return Boolean(
        render &&
          (render.phase === 'completed' ||
            render.phase === 'finished' ||
            render.phase === 'errored'),
      );
    },
    id,
    { timeout: 60_000 },
  );
}

// A DOM that has not mounted yet is perfectly stable, so the settle loop would
// happily capture an empty page. Resolve once the story root has a size, and
// return false rather than throw when a story finishes but renders nothing
// visible, so it can be skipped.
async function waitForVisible(page: Page): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const root = document.querySelector('#storybook-root');

        return Boolean(root && root.getBoundingClientRect().height > 0);
      },
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true)
    .catch(() => false);
}

async function readChromaticParameters(
  page: Page,
  id: string,
): Promise<ChromaticParameters | null> {
  return page.evaluate((storyId) => {
    const preview = (
      window as unknown as {
        __STORYBOOK_PREVIEW__?: {
          storyRenders?: {
            id: string;
            story?: {
              parameters?: {
                chromatic?: {
                  disableSnapshot?: boolean;
                  disable?: boolean;
                  delay?: number;
                };
              };
            };
          }[];
        };
      }
    ).__STORYBOOK_PREVIEW__;
    const renders = preview?.storyRenders ?? [];
    const render = renders.find((item) => item.id === storyId) ?? renders[0];

    return render?.story?.parameters?.chromatic ?? null;
  }, id);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);

  // Wait for the number of settled images to stop moving rather than for
  // completeness, which never arrives when a URL is deliberately broken.
  await page
    .waitForFunction(
      () => {
        const settled = Array.from(document.images).filter(
          (image) => image.complete,
        ).length;
        const store = window as unknown as {
          __argosImages?: { count: number; stable: number };
        };
        const state = (store.__argosImages ??= { count: -1, stable: 0 });
        state.stable = settled === state.count ? state.stable + 1 : 0;
        state.count = settled;

        return state.stable >= 3;
      },
      undefined,
      { timeout: 15_000, polling: 200 },
    )
    .catch(() => undefined);

  // Wake up the resize observers that measured before the webfonts were ready.
  const viewport = page.viewportSize();
  if (viewport) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height + 1,
    });
    await page.setViewportSize(viewport);
  }

  // Wait for animations that have an end. Infinite ones (loaders, skeleton
  // shimmers) never finish, and Argos freezes them at capture anyway.
  await page.evaluate(async () => {
    const running = document.getAnimations().filter((animation) => {
      if (animation.playState !== 'running') return false;
      const timing = animation.effect?.getComputedTiming();

      return typeof timing?.endTime === 'number' && isFinite(timing.endTime);
    });

    await Promise.all(
      running.map((animation) => animation.finished.catch(() => undefined)),
    );
  });

  // Finally, wait for the markup to stop changing.
  await page
    .waitForFunction(
      () => {
        const root = document.querySelector('#storybook-root');
        if (!root) return false;
        const sample = root.innerHTML;
        const store = window as unknown as {
          __argosMarkup?: { html: string; stable: number };
        };
        const state = (store.__argosMarkup ??= { html: '', stable: 0 });
        state.stable = sample === state.html ? state.stable + 1 : 0;
        state.html = sample;

        return state.stable >= 3;
      },
      undefined,
      { timeout: 20_000, polling: 150 },
    )
    .catch(() => undefined);
}

for (const story of stories) {
  test(labelFor(story), async ({ page }) => {
    // `chromatic=true` so the stories that branch on `isChromatic()` render the
    // same deterministic variant they render today.
    await page.goto(
      `/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story&chromatic=true`,
    );
    await waitForPhase(page, story.id);

    const chromatic = await readChromaticParameters(page, story.id);
    test.skip(
      Boolean(chromatic?.disableSnapshot || chromatic?.disable),
      'Story opts out of visual snapshots',
    );

    // A story that threw during render shows Storybook's error page. The error
    // wrapper is always in the DOM, so the signal is the body class.
    const errored = await page.evaluate(() =>
      document.body.classList.contains('sb-show-errordisplay'),
    );
    test.skip(errored, 'Story rendered Storybook error display');

    // A few stories finish rendering with no visible content, there is nothing
    // to snapshot so skip rather than fail.
    const visible = await waitForVisible(page);
    test.skip(!visible, 'Story renders no visible content');

    await settle(page);

    // Honour the delay the story already asks Chromatic for.
    if (typeof chromatic?.delay === 'number' && chromatic.delay > 0) {
      await page.waitForTimeout(Math.min(chromatic.delay, 5_000));
    }

    // Anything still busy at this point is the state the story wants to show,
    // not a load in flight.
    const staysBusy = await page.evaluate(
      () => document.querySelector('[aria-busy="true"]') !== null,
    );

    const masked = page.locator(IGNORE_SELECTOR);
    const mask = (await masked.count()) > 0 ? [masked] : undefined;

    await expect(page.locator('#storybook-root')).toBeVisible();
    await argosScreenshot(page, labelFor(story), {
      element: '#storybook-root',
      mask,
      stabilize: { waitForAriaBusy: !staysBusy },
    });
  });
}
