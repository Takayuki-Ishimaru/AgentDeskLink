import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { VisualStore } from '../src/visual.js';
import type { CapturedImage } from '../src/visual-types.js';

test('native source coordinates, per-axis desktop transform and epoch survive historical crops immutably', async () => {
  const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  const image: CapturedImage = {
    png,
    captured_at: new Date().toISOString(),
    coordinate_space: 'window_pixels',
    source_to_desktop: {
      origin_x: -1200,
      origin_y: 80,
      scale_x: 0.5,
      scale_y: 0.6,
      coordinate_space: 'desktop_points_top_left',
    },
    surface_epoch: 'native-epoch',
    viewport: { width: 320, height: 200, scroll_x: 0, scroll_y: 0, device_scale_factor: 2 },
    redacted: false,
  };
  const store = new VisualStore();
  const pending = store.record({ session_id: 's', target_id: 't', revision: 1 }, image);
  image.source_to_desktop!.origin_x = 999;
  image.surface_epoch = 'changed';
  const id = await pending;
  const crop = await store.view('s', id, { region: { x: 100, y: 40, width: 80, height: 100 }, max_dimension: 64 });
  assert.equal(crop.metadata.coordinate_space, 'window_pixels');
  assert.equal(crop.metadata.source_to_desktop!.origin_x, -1200);
  assert.equal(crop.metadata.source_to_desktop!.scale_y, 0.6);
  assert.equal(crop.metadata.surface_epoch, 'native-epoch');
  assert.equal(crop.metadata.region.x, 100);
  crop.metadata.source_to_desktop!.origin_x = 500;
  assert.equal((await store.view('s', id)).metadata.source_to_desktop!.origin_x, -1200);
  store.assertRetained('s', id);
  store.discard('other', id);
  store.assertRetained('s', id);
  store.discard('s', id);
  assert.throws(() => store.assertRetained('s', id), { code: 'E_TARGET_NOT_FOUND' });
});

test('native source requires a valid transform and frame freshness is independent of untrusted timestamps', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  const image: CapturedImage = {
    png,
    captured_at: '1970-01-01T00:00:00Z',
    coordinate_space: 'window_pixels',
    source_to_desktop: {
      origin_x: 0,
      origin_y: 0,
      scale_x: 1,
      scale_y: 1,
      coordinate_space: 'desktop_physical_pixels',
    },
    viewport: { width: 64, height: 64, scroll_x: 0, scroll_y: 0, device_scale_factor: 1 },
    redacted: false,
  };
  let now = 100;
  const store = new VisualStore({ now: () => now });
  await assert.rejects(
    store.record({ session_id: 's', target_id: 't', revision: 1 }, { ...image, source_to_desktop: undefined }),
    { code: 'E_INVALID_ARGUMENT' },
  );
  const id = await store.record({ session_id: 's', target_id: 't', revision: 1 }, image);
  now += 5001;
  assert.throws(() => store.assertRetained('s', id, 5000), { code: 'E_STALE_STATE' });
  store.assertRetained('s', id);
});
