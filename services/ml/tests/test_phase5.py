"""Phase 5 infrastructure: manifest validation, equal-area morphology, four-term
confidence, and the content-addressed model registry.

These tests encode the guarantees rather than the implementation: what the system must
refuse, and what it must never silently assume.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml
from shapely.geometry import Polygon

from varuna_ml.geo.morphology import compute_morphology
from varuna_ml.models.confidence import detection_confidence, wind_suitability
from varuna_ml.models.manifest import validate_manifest
from varuna_ml.models.registry import (
    ModelMetrics,
    RegistryError,
    promotion_allowed,
    register_model,
)

REPO = Path(__file__).resolve().parents[3]


# ── manifest ──────────────────────────────────────────────────────────


def write_manifest(tmp_path: Path, **overrides) -> Path:
    entry = {
        "id": "test-ds",
        "provider": "Some Institute",
        "citation": "Author, A. (2024). A real dataset of Sentinel-1 oil spill imagery. Journal.",
        "licence": "CC-BY-4.0",
        "retrieved_at": "2026-08-28T00:00:00Z",
        "sha256": "a" * 64,
        "real_data": True,
        "synthetic_content": "none",
        "split": {"train": 0.7, "val": 0.15, "test": 0.15},
        "split_strategy": "by scene and geography, never by random tile",
    }
    entry.update(overrides)
    doc = {
        "dataset_manifest": {
            "version": "test",
            "entries": [entry],
            "augmentation": {
                "permitted": ["hflip", "rot90"],
                "forbidden": ["gan_synthesis"],
            },
            "assertion": "no_synthetic_samples",
        }
    }
    p = tmp_path / "m.yaml"
    import yaml

    p.write_text(yaml.safe_dump(doc), encoding="utf-8")
    return p


def test_valid_manifest_passes(tmp_path):
    assert validate_manifest(write_manifest(tmp_path)).ok


def test_training_refuses_a_pending_download(tmp_path):
    """The guarantee: training cannot begin against data that has not been retrieved."""
    p = write_manifest(tmp_path, sha256="PENDING_DOWNLOAD")
    strict = validate_manifest(p, require_downloaded=True)
    assert not strict.ok
    assert any("has not been retrieved" in e for e in strict.errors)

    # The same manifest is legitimate to HOLD before acquisition.
    lenient = validate_manifest(p, require_downloaded=False)
    assert lenient.ok
    assert lenient.warnings


def test_rejects_non_real_or_synthetic_data(tmp_path):
    assert not validate_manifest(write_manifest(tmp_path, real_data=False)).ok
    r = validate_manifest(write_manifest(tmp_path, synthetic_content="augmented"))
    assert not r.ok
    assert any("synthetic_content" in e for e in r.errors)


def test_rejects_missing_citation_or_licence(tmp_path):
    assert not validate_manifest(write_manifest(tmp_path, citation="see website")).ok
    assert not validate_manifest(write_manifest(tmp_path, licence="")).ok


def test_rejects_label_altering_augmentation(tmp_path):
    import yaml

    p = write_manifest(tmp_path)
    doc = yaml.safe_load(p.read_text())
    doc["dataset_manifest"]["augmentation"]["permitted"].append("pasted_slicks")
    p.write_text(yaml.safe_dump(doc), encoding="utf-8")
    r = validate_manifest(p)
    assert not r.ok
    assert any("forbidden" in e for e in r.errors)


def test_rejects_split_that_does_not_sum_to_one(tmp_path):
    r = validate_manifest(write_manifest(tmp_path, split={"train": 0.8, "val": 0.3, "test": 0.15}))
    assert not r.ok


def test_repo_manifest_is_downloaded_and_usable():
    """The manifest declares a real, downloaded dataset and validates under
    `require_downloaded=True` — the state it could not reach while the entry read
    PENDING_DOWNLOAD."""
    p = REPO / "data" / "manifests" / "dataset_manifest.yaml"
    assert validate_manifest(p, require_downloaded=True).ok

    doc = yaml.safe_load(p.read_text(encoding="utf-8"))
    entries = doc["dataset_manifest"]["entries"]
    assert entries, "manifest must declare at least one dataset"
    for e in entries:
        frac = e["split"]
        assert abs(sum(frac.values()) - 1.0) < 1e-6, f"{e['id']} splits must partition the set"


def test_train_and_test_splits_share_no_geography():
    """The anti-leakage invariant, now that training is allowed on this data.

    This replaced an assertion that every entry declared `train: 0.0`, which was the right
    check while the only dataset on disk was a held-out test set and nothing could be trained
    on it. Once a train split exists that assertion had to go, but the thing it protected did
    not: the reported test numbers are only meaningful if the model never saw those scenes.

    Geographic disjointness is the sharp version of that. These images are tiles cut from a
    smaller number of Sentinel-1 acquisitions, so tiles from one acquisition share sea state,
    wind, look-alike population and often the same slick. A split that separates individual
    tiles but not their source scenes leaks near-duplicates into the test set and inflates
    IoU without any generalisation — and it fails silently, by producing a better number.
    """
    split_path = REPO / "data" / "splits" / "part3-split.json"
    if not split_path.exists():
        pytest.skip("split not generated in this checkout")

    split = json.loads(split_path.read_text(encoding="utf-8"))
    cells = {name: {tuple(c) for c in split["cells"][name]} for name in ("train", "val", "test")}

    assert not (cells["train"] & cells["test"]), "a geographic cell is in BOTH train and test"
    assert not (cells["train"] & cells["val"]), "a geographic cell is in BOTH train and val"
    assert not (cells["val"] & cells["test"]), "a geographic cell is in BOTH val and test"

    # Every class must be present in test, or a class-specific rate cannot be reported at
    # all — the look-alike false-positive rate above all.
    for cls, n in split["counts"]["test"].items():
        assert n > 0, f"test split contains no {cls} scenes"


# ── morphology ────────────────────────────────────────────────────────


def test_morphology_is_measured_in_metres_not_degrees():
    """A square in DEGREES is not square on the ground away from the equator.

    Measuring shape in degree space would report elongation 1.0 for this polygon at 60N,
    when the true ground shape is about 2:1. Since elongation is a primary oil-versus-
    look-alike discriminator, that distortion would bias the classification itself.
    """
    box = Polygon([(0, 60), (1, 60), (1, 61), (0, 61), (0, 60)])
    m = compute_morphology(box)
    assert m.elongation_ratio > 1.6, "east-west foreshortening at 60N must be visible"
    assert 3000 < m.area_km2 < 7000


def test_morphology_of_a_circle_is_compact_and_unelongated():
    circle = Polygon(
        [
            (
                144.6 + 0.02 * __import__("math").cos(t / 20 * 6.28318),
                13.4 + 0.02 * __import__("math").sin(t / 20 * 6.28318),
            )
            for t in range(20)
        ]
    )
    m = compute_morphology(circle)
    assert m.elongation_ratio < 1.2
    assert m.compactness > 0.85
    assert m.convexity > 0.9


def test_orientation_is_an_axis_not_a_direction():
    """A slick has an orientation, not a heading, so the bearing folds onto [0, 180)."""
    box = Polygon([(144.0, 13.0), (144.3, 13.0), (144.3, 13.02), (144.0, 13.02), (144.0, 13.0)])
    m = compute_morphology(box)
    assert 0.0 <= m.orientation_deg < 180.0


def test_real_detection_morphology():
    dets = json.loads(
        (REPO / "data" / "incidents" / "guam-2025-09-21-detections.json").read_text(
            encoding="utf-8"
        )
    )
    from shapely.geometry import shape

    m = compute_morphology(shape(dets[0]["geometry"]))
    assert m.area_km2 > 0.5
    assert m.elongation_ratio > 1.0
    # A real slick outline is ragged: far from a circle.
    assert m.compactness < 0.5


# ── confidence ────────────────────────────────────────────────────────


def test_unknown_wind_is_not_treated_as_good_conditions():
    """The guarantee: a missing measurement must not inflate confidence."""
    assert wind_suitability(None) == 0.5
    assert wind_suitability(6.0) == 1.0
    assert wind_suitability(1.0) < 0.1  # glassy sea: everything looks like oil
    assert wind_suitability(16.0) < 0.1  # slick re-roughened away

    unknown = detection_confidence(None, 4.0, None, 0.2)
    good = detection_confidence(None, 4.0, 6.0, 0.2)
    assert unknown.overall < good.overall
    assert unknown.wind_known is False


def test_all_four_terms_are_returned_separately():
    c = detection_confidence(
        mean_oil_probability=None, contrast_db=8.0, wind_ms=6.0, look_alike_risk=0.1
    )
    for term in (c.model_term, c.separation_term, c.wind_term, c.shape_term):
        assert 0.0 <= term <= 1.0
    # The raw inputs travel with the score so the UI can show "8.0 dB", not only "0.80".
    assert c.contrast_db == 8.0
    assert c.wind_ms == 6.0


def test_classical_detector_reports_no_calibrated_probability():
    """It must not invent one: mean_oil_probability stays null."""
    c = detection_confidence(None, 5.0, 6.0, 0.3)
    assert c.mean_oil_probability is None


def test_a_high_look_alike_risk_lowers_confidence():
    low = detection_confidence(None, 5.0, 6.0, 0.1)
    high = detection_confidence(None, 5.0, 6.0, 0.9)
    assert high.overall < low.overall


# ── registry ──────────────────────────────────────────────────────────


def test_registry_refuses_metrics_without_a_dataset_hash(tmp_path):
    with pytest.raises(RegistryError, match="dataset manifest hash"):
        register_model(
            tmp_path / "r.json",
            sha256="c" * 64,
            name="m",
            version="1",
            architecture="u-net",
            input_bands=["VV"],
            classes=["oil"],
            metrics=ModelMetrics(0.6, 0.75, 0.7, 0.8, 0.65, 0.15),
        )


def test_registry_refuses_absent_metrics_without_a_reason(tmp_path):
    with pytest.raises(RegistryError, match="metrics_absent_reason"):
        register_model(
            tmp_path / "r.json",
            sha256="d" * 64,
            name="m",
            version="1",
            architecture="classical",
            input_bands=["VV"],
            classes=["oil"],
            metrics=None,
        )


def test_registry_accepts_an_untrained_detector_that_says_so(tmp_path):
    e = register_model(
        tmp_path / "r.json",
        sha256="e" * 64,
        name="classical",
        version="1",
        architecture="threshold",
        input_bands=["VV"],
        classes=["dark_feature"],
        metrics=None,
        metrics_absent_reason="not a trained model; no held-out test split exists",
    )
    assert e.metrics is None
    assert e.real_data_only is True


def test_promotion_gate_blocks_more_look_alike_false_positives():
    """The case that matters: a model can raise IoU while calling more look-alikes oil,
    producing a system that accuses more innocent vessels."""
    deployed = ModelMetrics(0.60, 0.75, 0.72, 0.80, 0.66, 0.12)
    better_iou_worse_fp = ModelMetrics(0.65, 0.78, 0.75, 0.82, 0.69, 0.18)
    ok, why = promotion_allowed(better_iou_worse_fp, deployed)
    assert not ok
    assert "look-alike" in why


def test_promotion_gate_blocks_below_the_mvp_floor():
    ok, why = promotion_allowed(ModelMetrics(0.40, 0.60, 0.55, 0.65, 0.50, 0.10), None)
    assert not ok
    assert "below the MVP floor" in why


def test_promotion_gate_allows_a_genuine_improvement():
    deployed = ModelMetrics(0.60, 0.75, 0.72, 0.80, 0.66, 0.12)
    ok, _ = promotion_allowed(ModelMetrics(0.65, 0.78, 0.75, 0.82, 0.69, 0.10), deployed)
    assert ok
