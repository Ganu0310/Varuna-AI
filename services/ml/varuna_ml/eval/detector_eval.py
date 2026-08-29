"""Measure the classical dark-spot detector against a real held-out test split.

14 §14.6 Phase 13 exit criterion: "Model MVP metrics met on the held-out real test split."

Until now the dossier has carried this admission, because it was true:

    "Detection used a classical adaptive-threshold algorithm... it cannot classify oil versus
    look-alike from texture, and has NO MEASURED oil-IoU or false-positive rate on a held-out
    test split."

This module produces those numbers. It trains nothing: the detector is analytic, so its
test-set performance can be measured directly, and there is no train/test leakage to worry
about because the detector never saw any of it.

The split is Part III of the Trujillo-Acatitla et al. Sentinel-1 dataset (CC-BY-4.0) — 150
oil, 150 look-alike and 150 oil-free scenes, each 2048x2048 dual-pol Sigma0 in dB with a
pixel-aligned binary mask.

TWO PROPERTIES OF THIS DATA THAT WILL SILENTLY CORRUPT THE RESULT IF MISHANDLED:

1. The imagery is already in DECIBELS. `darkspot.detect()` expects LINEAR Sigma0 and converts
   internally via `10*log10`, discarding anything <= 1e-6. Feeding dB straight in leaves
   almost no valid pixels, the sea-area guard trips, and every scene returns zero detections
   — which would read as a flawless 0% false-positive rate.

2. The band order is (VH, VV), NOT the "(VV, VH)" the dataset description states. Measured
   over sea pixels across 58 scenes, band 2 exceeds band 1 by +6.42 dB on average and is
   stronger in 97% of them, which is the co-pol/cross-pol separation. The detector wants VV,
   so it gets band 2. Trusting the documentation would run it on the noisier cross-pol band
   and understate detection quality throughout.

Look-alike and oil-free masks are entirely zero: the look-alike feature is present in the
imagery but is NOT oil, so any detection there is a false positive. That makes the look-alike
class the honest test of this detector's known weakness rather than a formality.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import rasterio

from varuna_ml.detect.darkspot import detect

# Band 2 of 2. See the module docstring: determined by measurement, not by the dataset's
# own description, which has the order the other way round.
VV_BAND = 2

# The dataset is Sentinel-1 IW GRD resampled to ~10 m (8.98e-05 deg at ~35 N is 9.97 m).
PIXEL_SIZE_M = 10.0


@dataclass
class SceneResult:
    scene: str
    truth_class: str
    gt_positive_px: int
    pred_positive_px: int
    intersection_px: int
    union_px: int
    iou: float | None
    n_detections: int
    max_confidence: float | None
    mean_look_alike_risk: float | None


def db_to_linear(db: np.ndarray) -> np.ndarray:
    """Decibels back to linear Sigma0.

    `detect()` immediately re-applies 10*log10. Round-tripping is deliberate: it keeps this
    evaluation on exactly the code path production uses, rather than a shortcut variant that
    could diverge from it.
    """
    out = np.zeros(db.shape, dtype=np.float32)
    finite = np.isfinite(db)
    out[finite] = np.power(10.0, db[finite] / 10.0)
    return out


def evaluate_scene(image_path: Path, mask_path: Path, truth_class: str) -> SceneResult:
    with rasterio.open(image_path) as src:
        db = src.read(VV_BAND).astype("float32")
    with rasterio.open(mask_path) as src:
        gt = src.read(1) > 0

    spots = detect(db_to_linear(db), pixel_size_m=PIXEL_SIZE_M)

    pred = np.zeros(gt.shape, dtype=bool)
    for s in spots:
        pred |= s.mask

    inter = int(np.logical_and(pred, gt).sum())
    union = int(np.logical_or(pred, gt).sum())

    # IoU is undefined when neither mask has any foreground — a correct rejection on an
    # oil-free scene. Reporting 1.0 there would inflate the mean with scenes that contain no
    # oil to find; reporting 0.0 would punish a correct answer. It is recorded as None and
    # counted separately.
    iou = (inter / union) if union > 0 else None

    return SceneResult(
        scene=image_path.name,
        truth_class=truth_class,
        gt_positive_px=int(gt.sum()),
        pred_positive_px=int(pred.sum()),
        intersection_px=inter,
        union_px=union,
        iou=iou,
        n_detections=len(spots),
        max_confidence=max((s.confidence for s in spots), default=None),
        mean_look_alike_risk=(
            float(np.mean([s.look_alike_risk for s in spots])) if spots else None
        ),
    )


def evaluate_from_split(root: Path, split_file: Path, which: str = "test") -> dict:
    """Score only the scenes in one side of the geographic split.

    Added so the classical detector can be measured on exactly the 66 scenes the U-Net is
    tested on. The original whole-dataset figures covered all 450, 315 of which later became
    training data — comparing a learned model's test score against that would be comparing
    two different questions and flattering whichever number was quoted second.
    """
    import json as _json

    split = _json.loads(split_file.read_text(encoding="utf-8"))
    results: list[SceneResult] = []
    for item in split["items"][which]:
        results.append(
            evaluate_scene(root / item["image"], root / item["mask"], item["cls"])
        )
    return summarise(results)


def evaluate_split(root: Path, limit: int | None = None) -> dict:
    """Run every scene in the Part III test split.

    `limit` caps scenes PER CLASS, for a quick pass; the reported summary always states how
    many scenes it was computed from so a partial run can never be quoted as a full one.
    """
    classes = {
        "oil": ("Oil", "Oil"),
        "lookalike": ("Lookalike", "Lookalike"),
        "no_oil": ("No oil", "No oil"),
    }

    results: list[SceneResult] = []
    for key, (img_dir, mask_dir) in classes.items():
        images = sorted((root / "Images" / img_dir).glob("*.tif"))
        if limit:
            images = images[:limit]
        for img in images:
            mask = root / "Mask" / mask_dir / f"{img.stem}_segmentation.tif"
            if not mask.exists():
                raise FileNotFoundError(f"no mask for {img} (expected {mask})")
            results.append(evaluate_scene(img, mask, key))

    return summarise(results)


def summarise(results: list[SceneResult]) -> dict:
    def of(cls: str) -> list[SceneResult]:
        return [r for r in results if r.truth_class == cls]

    oil, look, none_ = of("oil"), of("lookalike"), of("no_oil")

    oil_ious = [r.iou for r in oil if r.iou is not None]
    # "Detected" means the prediction overlaps the true slick at all. Reported beside IoU
    # because they answer different questions: whether the analyst is pointed at the right
    # patch of sea, versus how precisely its extent is traced.
    oil_hits = sum(1 for r in oil if r.intersection_px > 0)

    def fp_rate(rs: list[SceneResult]) -> float | None:
        return (sum(1 for r in rs if r.n_detections > 0) / len(rs)) if rs else None

    summary = {
        "counts": {"oil": len(oil), "lookalike": len(look), "no_oil": len(none_)},
        "oil": {
            "mean_iou": float(np.mean(oil_ious)) if oil_ious else None,
            "median_iou": float(np.median(oil_ious)) if oil_ious else None,
            "detection_rate": (oil_hits / len(oil)) if oil else None,
            "scenes_with_no_detection": sum(1 for r in oil if r.n_detections == 0),
        },
        "false_positives": {
            # The measurement that matters most for this detector: a dark feature that is not
            # oil. These scenes contain exactly that, and their masks are empty.
            "lookalike_scene_fp_rate": fp_rate(look),
            "no_oil_scene_fp_rate": fp_rate(none_),
            "lookalike_mean_detections": (
                float(np.mean([r.n_detections for r in look])) if look else None
            ),
            "no_oil_mean_detections": (
                float(np.mean([r.n_detections for r in none_])) if none_ else None
            ),
            "lookalike_mean_risk_flagged": _mean_risk(look),
            "no_oil_mean_risk_flagged": _mean_risk(none_),
        },
        "per_scene": [asdict(r) for r in results],
    }
    return summary


def _mean_risk(rs: list[SceneResult]) -> float | None:
    """Mean look-alike risk the detector assigned on scenes where it fired wrongly.

    If the detector flags a false positive but marks it high-risk, an analyst is warned; if it
    flags one confidently, they are misled. The distinction matters more than the raw rate.
    """
    vals = [r.mean_look_alike_risk for r in rs if r.mean_look_alike_risk is not None]
    return float(np.mean(vals)) if vals else None


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", required=True, type=Path, help="Part III root (has Images/, Mask/)")
    ap.add_argument("--limit", type=int, default=None, help="scenes per class (quick pass)")
    ap.add_argument("--split-file", type=Path, default=None, help="score one side of a split")
    ap.add_argument("--which", default="test", help="which side of --split-file")
    ap.add_argument("--out", type=Path, default=None, help="write full JSON results here")
    args = ap.parse_args()

    summary = (
        evaluate_from_split(args.root, args.split_file, args.which)
        if args.split_file
        else evaluate_split(args.root, limit=args.limit)
    )

    c = summary["counts"]
    o = summary["oil"]
    f = summary["false_positives"]

    print("\nclassical dark-spot detector — real held-out test split")
    print(
        f"  scenes            {c['oil']} oil, {c['lookalike']} look-alike, {c['no_oil']} oil-free"
    )
    print("\n  oil segmentation")
    print(f"    mean IoU        {_fmt(o['mean_iou'])}")
    print(f"    median IoU      {_fmt(o['median_iou'])}")
    print(f"    detection rate  {_pct(o['detection_rate'])}  (prediction overlaps the true slick)")
    print(f"    missed entirely {o['scenes_with_no_detection']} of {c['oil']}")
    print("\n  false positives (these masks are empty — ANY detection is wrong)")
    print(
        f"    look-alike      {_pct(f['lookalike_scene_fp_rate'])} of scenes, "
        f"{_fmt(f['lookalike_mean_detections'])} detections/scene"
    )
    print(
        f"    oil-free        {_pct(f['no_oil_scene_fp_rate'])} of scenes, "
        f"{_fmt(f['no_oil_mean_detections'])} detections/scene"
    )
    print(f"    risk flagged on look-alike FPs  {_fmt(f['lookalike_mean_risk_flagged'])}")
    print(f"    risk flagged on oil-free FPs    {_fmt(f['no_oil_mean_risk_flagged'])}")
    print()

    if args.out:
        args.out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(f"  full per-scene results -> {args.out}\n")


def _fmt(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.3f}"


def _pct(v: float | None) -> str:
    return "n/a" if v is None else f"{100 * v:.1f}%"


if __name__ == "__main__":
    main()
