"""The geometric coastline mask.

The test that matters here is the last one: a dark patch of land that the brightness mask
waves straight through, and which only geometry rejects. That is the car-park failure, and
it is the reason this module exists.
"""

from __future__ import annotations

import numpy as np
import pytest

rasterio = pytest.importorskip("rasterio", reason="rasterio ships with the Phase 4 extras")

from rasterio.transform import from_origin  # noqa: E402

from varuna_ml.detect.darkspot import detect, land_mask_from_backscatter  # noqa: E402
from varuna_ml.detect.landmask import (  # noqa: E402
    CoastlineUnavailable,
    coastline_mask,
)

# Apra Harbour, Guam — the staged demo region, and inside the 10 m clip.
GUAM_TRANSFORM = from_origin(144.60, 13.50, 0.001, 0.001)
# Mid-Pacific, thousands of km from anything.
OPEN_OCEAN_TRANSFORM = from_origin(-140.0, -20.0, 0.001, 0.001)


def test_open_ocean_is_not_masked():
    """No land within the scene is a real answer, and must not read as a missing one."""
    lm = coastline_mask((256, 256), OPEN_OCEAN_TRANSFORM, "EPSG:4326", buffer_m=500)
    assert lm.land_fraction == 0.0
    assert not lm.mask.any()
    assert lm.provenance["coversScene"] is False


def test_coastal_scene_masks_land_and_records_where_it_came_from():
    lm = coastline_mask((512, 512), GUAM_TRANSFORM, "EPSG:4326", buffer_m=500)
    assert lm.mask.any(), "Guam should put land in a scene centred on Apra Harbour"
    assert 0.0 < lm.land_fraction < 1.0, "a harbour scene is neither all land nor all sea"
    assert lm.resolution == "10m", "Guam is inside the 10 m clip region"
    assert lm.provenance["provider"] == "Natural Earth"
    assert lm.provenance["licence"].startswith("Public domain")


def test_the_buffer_grows_land_and_only_land():
    """The direction of the buffer is the whole safety argument, so assert the direction."""
    tight = coastline_mask((512, 512), GUAM_TRANSFORM, "EPSG:4326", buffer_m=0)
    grown = coastline_mask((512, 512), GUAM_TRANSFORM, "EPSG:4326", buffer_m=1000)

    assert grown.land_fraction > tight.land_fraction
    # Every pixel the tight mask calls land is still land in the grown one. If this fails the
    # buffer is eroding somewhere, which would open exactly the hole it exists to close.
    assert np.all(grown.mask[tight.mask])
    assert tight.buffered_fraction == 0.0
    assert grown.buffered_fraction > 0.0


def test_coastal_water_given_up_is_reported_not_hidden():
    lm = coastline_mask((512, 512), GUAM_TRANSFORM, "EPSG:4326", buffer_m=500)
    assert lm.buffered_fraction > 0.0
    assert lm.buffer_m == 500
    # An analyst reading a null result near a shore has to be able to find this number.
    assert "buffered_fraction" in lm.__dataclass_fields__


def test_mask_of_the_wrong_shape_is_refused():
    scene = np.full((64, 64), 0.01, dtype=np.float32)
    with pytest.raises(ValueError, match="does not match scene"):
        detect(scene, coastline=np.zeros((32, 32), dtype=bool))


def test_dark_land_defeats_the_brightness_mask_and_is_caught_by_geometry():
    """The car park.

    A patch of land that is DARK in C-band — wet asphalt, a runway, calm inland water. The
    brightness mask is looking for bright pixels, so it does not see this at all, and the
    detector is handed a large dark blob sitting on land.
    """
    height = width = 512
    rng = np.random.default_rng(20260829)

    # Sea: moderate backscatter with speckle.
    sigma0 = rng.gamma(shape=4.0, scale=0.02, size=(height, width)).astype(np.float32)

    lm = coastline_mask((height, width), GUAM_TRANSFORM, "EPSG:4326", buffer_m=0)
    land_px = np.argwhere(lm.mask)
    assert len(land_px) > 5000, "need a decent land area to place a dark patch inside"

    # Put a dark rectangle wholly inside the land, big enough to clear the min-area gate.
    r0, c0 = land_px[len(land_px) // 2]
    r0 = int(np.clip(r0 - 20, 0, height - 41))
    c0 = int(np.clip(c0 - 20, 0, width - 41))
    patch = (slice(r0, r0 + 40), slice(c0, c0 + 40))
    sigma0[patch] = 0.0008  # ≈ -31 dB: unambiguously dark

    # Make the surrounding land bright, as land normally is, so the ONLY thing the
    # brightness mask misses is the dark patch itself.
    bright_land = lm.mask.copy()
    bright_land[patch] = False
    sigma0[bright_land] = 0.5

    db = 10.0 * np.log10(sigma0)
    brightness_only = land_mask_from_backscatter(db)
    assert not brightness_only[r0 + 20, c0 + 20], (
        "premise of this test: the brightness mask does NOT catch dark land"
    )

    without = detect(sigma0, pixel_size_m=10.0, min_area_km2=0.05)
    with_coast = detect(sigma0, pixel_size_m=10.0, min_area_km2=0.05, coastline=lm.mask)

    def hits_patch(spots):
        return any(s.mask[patch].sum() > 400 for s in spots)

    assert hits_patch(without), "brightness alone should report the dark land patch"
    assert not hits_patch(with_coast), "geometry must reject it"


def test_missing_vendored_data_raises_rather_than_returning_empty():
    """An empty mask and a missing mask must not be the same value.

    'No land here' and 'we do not know where the land is' lead to opposite decisions, so the
    module refuses to conflate them.
    """
    from varuna_ml.detect import landmask

    landmask._load.cache_clear()
    original = landmask.DATA_DIR
    landmask.DATA_DIR = original.parent / "does-not-exist"
    try:
        with pytest.raises(CoastlineUnavailable, match="build-basemap"):
            coastline_mask((64, 64), GUAM_TRANSFORM, "EPSG:4326")
    finally:
        landmask.DATA_DIR = original
        landmask._load.cache_clear()
