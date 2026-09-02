"""Detector parameter sweep on the real geographic split — 14 Phase 9.

THE PROBLEM THIS EXISTS TO ATTACK. Measured on 66 held-out scenes, `darkspot-v1` overlaps
every true slick (100% detection rate) and also fires on 68.2% of look-alike scenes. Worse,
the mean look-alike risk it assigned to those false positives was 0.26 — it was not merely
wrong, it was *unwarned*. A perfect back-track on a false detection is a confident answer to
the wrong question, so this is the first number worth moving.

METHOD, and the two rules that keep the result meaningful:

 1. TUNE ON train+val, MEASURE ONCE ON test. The classical detector is analytic and was never
    fitted to anything, so the 315 training scenes are legitimately available as development
    data — and 384 scenes resolve a false-positive rate to ~0.8 points where val alone (69)
    resolves it to ~4.3. The test split stays sealed until a configuration has been chosen.

 2. RECALL IS A CONSTRAINT, NOT A TERM IN A SCORE. Folding detection rate and false-positive
    rate into one weighted number lets a configuration buy a big FP reduction by quietly
    dropping real slicks. So oil detection rate is a hard floor and the objective is the
    look-alike rate alone, with oil IoU as the tie-break.

WHY IT IS FAST ENOUGH TO SWEEP. A full `detect()` is ~1.4 s per 2048x2048 scene, and a naive
grid over 384 scenes would run for hours. Two structural facts remove almost all of it:

  * the background field, the land mask and the dB conversion do not depend on ANY parameter
    under test, so they are computed once per scene (~0.64 s) and reused;
  * every filter except the contrast threshold is a POST-HOC test on connected-component
    properties. Once components exist, changing a minimum area or an elongation gate is a
    predicate over a list, not a re-segmentation.

So the only axis that costs real work is `contrast_db`, and everything else is swept for free.

IoU WITHOUT STORING MASKS. Connected components are disjoint by construction, so for any
subset of surviving components the union's area is the sum of their areas and its intersection
with the truth is the sum of their intersections. That makes IoU exact from two integers per
component, and no 2048x2048 boolean array is ever retained.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import rasterio
from skimage import measure

from varuna_ml.detect.darkspot import (
    clean,
    land_mask_from_backscatter,
    look_alike_risk,
    segment,
    to_db,
)
from varuna_ml.eval.detector_eval import PIXEL_SIZE_M, VV_BAND, db_to_linear


@dataclass(frozen=True)
class Config:
    """One point in the parameter space. `contrast_db` is the only expensive axis."""

    contrast_db: float
    min_area_km2: float
    min_elongation: float
    max_look_alike_risk: float

    def label(self) -> str:
        return (
            f"c{self.contrast_db:g}_a{self.min_area_km2:g}"
            f"_e{self.min_elongation:g}_r{self.max_look_alike_risk:g}"
        )


@dataclass
class Component:
    """One connected component, reduced to what every downstream filter needs."""

    area_px: int
    area_km2: float
    elongation: float
    convexity: float
    contrast_db: float
    risk: float
    intersection_px: int


# The floor used when extracting components. Every swept `min_area_km2` must be >= this, since
# anything smaller was already discarded and cannot be recovered by a post-hoc filter.
EXTRACTION_MIN_AREA_KM2 = 0.05


def components_for_scene(
    db: np.ndarray,
    gt: np.ndarray,
    contrast_db: float,
    pixel_size_m: float = PIXEL_SIZE_M,
) -> list[Component]:
    """Segment once at one contrast threshold and reduce to per-component properties."""
    finite = np.isfinite(db)
    land = land_mask_from_backscatter(db)
    sea = finite & ~land
    if int(sea.sum()) < 1000:
        return []

    px_area_km2 = (pixel_size_m**2) / 1e6
    min_px = max(50, int(EXTRACTION_MIN_AREA_KM2 / px_area_km2))

    dark, bg = segment(db, sea, contrast_db=contrast_db)
    dark &= sea
    dark = clean(dark, min_px)

    labels = measure.label(dark, connectivity=2)
    if labels.max() == 0:
        return []

    out: list[Component] = []
    for region in measure.regionprops(labels):
        if region.area < min_px:
            continue
        comp = labels == region.label
        mean_db = float(np.nanmean(db[comp]))
        back_db = float(np.nanmean(bg[comp]))
        contrast = back_db - mean_db

        area_km2 = region.area * px_area_km2
        major_km = region.axis_major_length * pixel_size_m / 1000.0
        minor_km = max(region.axis_minor_length, 1.0) * pixel_size_m / 1000.0
        elong = major_km / minor_km
        convexity = float(region.area / region.area_convex) if region.area_convex else 1.0

        out.append(
            Component(
                area_px=int(region.area),
                area_km2=area_km2,
                elongation=float(elong),
                convexity=convexity,
                contrast_db=float(contrast),
                risk=look_alike_risk(elong, convexity, contrast, area_km2),
                intersection_px=int(np.logical_and(comp, gt).sum()),
            )
        )
    return out


def survives(c: Component, cfg: Config) -> bool:
    """Every post-hoc gate, in one predicate.

    The elongation gate is the one with a physical argument behind it rather than a tuned
    constant: a real slick is drawn out by the wind and current shear that moved it, while
    low-wind zones, rain cells and biogenic films are blobby. Requiring elongation is
    therefore a test for the mechanism, not merely a filter that happens to help.
    """
    if c.area_km2 < cfg.min_area_km2:
        return False
    if c.elongation < cfg.min_elongation:
        return False
    return not c.risk > cfg.max_look_alike_risk


@dataclass
class SceneOutcome:
    cls: str
    gt_px: int
    pred_px: int
    inter_px: int
    n_detections: int
    mean_risk: float | None


def score_scene(comps: list[Component], gt_px: int, cls: str, cfg: Config) -> SceneOutcome:
    kept = [c for c in comps if survives(c, cfg)]
    pred_px = sum(c.area_px for c in kept)
    inter_px = sum(c.intersection_px for c in kept)
    return SceneOutcome(
        cls=cls,
        gt_px=gt_px,
        pred_px=pred_px,
        inter_px=inter_px,
        n_detections=len(kept),
        mean_risk=float(np.mean([c.risk for c in kept])) if kept else None,
    )


def summarise(outcomes: list[SceneOutcome]) -> dict:
    oil = [o for o in outcomes if o.cls == "oil"]
    look = [o for o in outcomes if o.cls == "lookalike"]
    none_ = [o for o in outcomes if o.cls == "no_oil"]

    ious = []
    for o in oil:
        union = o.pred_px + o.gt_px - o.inter_px
        if union > 0:
            ious.append(o.inter_px / union)

    def fp_rate(rs: list[SceneOutcome]) -> float | None:
        return (sum(1 for r in rs if r.n_detections > 0) / len(rs)) if rs else None

    def mean_risk(rs: list[SceneOutcome]) -> float | None:
        vals = [r.mean_risk for r in rs if r.n_detections > 0 and r.mean_risk is not None]
        return float(np.mean(vals)) if vals else None

    return {
        "counts": {"oil": len(oil), "lookalike": len(look), "no_oil": len(none_)},
        "oil_mean_iou": float(np.mean(ious)) if ious else None,
        "oil_median_iou": float(np.median(ious)) if ious else None,
        "oil_detection_rate": (sum(1 for o in oil if o.inter_px > 0) / len(oil)) if oil else None,
        "oil_missed": sum(1 for o in oil if o.n_detections == 0),
        "lookalike_fp_rate": fp_rate(look),
        "no_oil_fp_rate": fp_rate(none_),
        "lookalike_mean_risk_on_fp": mean_risk(look),
        "mean_detections_per_oil_scene": (
            float(np.mean([o.n_detections for o in oil])) if oil else None
        ),
    }


def load_scene(root: Path, item: dict) -> tuple[np.ndarray, np.ndarray, int]:
    with rasterio.open(root / item["image"]) as src:
        raw = src.read(VV_BAND).astype("float32")
    with rasterio.open(root / item["mask"]) as src:
        gt = src.read(1) > 0
    # The imagery is already in decibels; `to_db` is re-applied so the sweep runs on exactly
    # the production code path rather than a shortcut variant that could diverge from it.
    return to_db(db_to_linear(raw)), gt, int(gt.sum())


def sweep(
    root: Path,
    split_file: Path,
    which: list[str],
    configs: list[Config],
    progress_every: int = 25,
) -> dict:
    """Evaluate every config over every scene in the named split sides."""
    split = json.loads(split_file.read_text(encoding="utf-8"))
    items = [it for side in which for it in split["items"][side]]

    contrasts = sorted({c.contrast_db for c in configs})
    per_config: dict[str, list[SceneOutcome]] = {c.label(): [] for c in configs}

    for n, item in enumerate(items, 1):
        db, gt, gt_px = load_scene(root, item)
        # One segmentation per contrast value, shared by every config using it.
        by_contrast = {ct: components_for_scene(db, gt, ct) for ct in contrasts}
        for cfg in configs:
            per_config[cfg.label()].append(
                score_scene(by_contrast[cfg.contrast_db], gt_px, item["cls"], cfg)
            )
        if progress_every and n % progress_every == 0:
            print(f"  {n}/{len(items)} scenes", flush=True)

    return {
        "split": f"{split_file.name} :: {'+'.join(which)} ({len(items)} scenes)",
        "results": {
            cfg.label(): {"config": asdict(cfg), **summarise(per_config[cfg.label()])}
            for cfg in configs
        },
    }


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--split-file", required=True, type=Path)
    ap.add_argument("--which", nargs="+", default=["val"])
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--stage", default="threshold", help="which rung of the ladder to sweep")
    ap.add_argument(
        "--config",
        default=None,
        help=(
            "evaluate ONE explicit configuration as "
            "'contrast,minAreaKm2,minElongation,maxRisk'. This is how the sealed test split is "
            "measured: a single pre-registered configuration, once, with no sweep — a sweep "
            "over test would silently turn the held-out set into a tuning set."
        ),
    )
    args = ap.parse_args()

    if args.config:
        c, a, e, r = (float(x) for x in args.config.split(","))
        configs = [Config(c, a, e, r)]
        args.stage = f"single:{args.config}"
    else:
        configs = build_configs(args.stage)
    print(f"\n{len(configs)} configurations, stage '{args.stage}'\n", flush=True)

    result = sweep(args.root, args.split_file, args.which, configs)
    result["stage"] = args.stage

    print(f"\n{result['split']}\n")
    header = f"{'config':34s} {'oilIoU':>7s} {'oilDet':>7s} {'lookFP':>7s} {'cleanFP':>8s}"
    print(header)
    print("-" * len(header))
    for label, r in result["results"].items():
        print(
            f"{label:34s} {_f(r['oil_mean_iou']):>7s} {_p(r['oil_detection_rate']):>7s} "
            f"{_p(r['lookalike_fp_rate']):>7s} {_p(r['no_oil_fp_rate']):>8s}"
        )

    if args.out:
        args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"\n  -> {args.out}\n")


def build_configs(stage: str) -> list[Config]:
    """The ladder, one rung at a time, in the order 14 Phase 9 specifies.

    Each rung holds the rungs below it at their chosen value, so an improvement can be
    attributed to the parameter that produced it rather than to an unexplained combination.
    """
    base = dict(contrast_db=3.0, min_area_km2=0.05, min_elongation=0.0, max_look_alike_risk=1.0)

    if stage == "threshold":
        return [Config(**{**base, "contrast_db": c}) for c in (2.5, 3.0, 3.5, 4.0, 4.5, 5.0)]
    if stage == "area":
        return [Config(**{**base, "min_area_km2": a}) for a in (0.05, 0.1, 0.2, 0.4, 0.8, 1.5, 3.0)]
    if stage == "elongation":
        return [Config(**{**base, "min_elongation": e}) for e in (0.0, 1.5, 2.0, 2.5, 3.0, 4.0)]
    if stage == "risk":
        return [
            Config(**{**base, "max_look_alike_risk": r})
            for r in (1.0, 0.5, 0.4, 0.35, 0.3, 0.25, 0.2)
        ]
    if stage == "combine":
        # The rungs measured independently are not additive — a component dropped by the area
        # gate cannot be dropped again by the risk gate — so the promising ones are crossed
        # and measured together. All at the baseline contrast, because the threshold rung
        # proved to be the worst lever available: it buys look-alike rejection by shrinking
        # every detected region, so IoU falls roughly twice as fast as the FP rate.
        out = []
        for a in (0.05, 0.1, 0.2, 0.4):
            for e in (0.0, 2.0, 2.5):
                for r in (1.0, 0.3, 0.25):
                    out.append(
                        Config(
                            contrast_db=3.0,
                            min_area_km2=a,
                            min_elongation=e,
                            max_look_alike_risk=r,
                        )
                    )
        return out
    if stage == "ladder":
        # Every rung in ONE pass. The expensive axis is `contrast_db`, and the other three
        # rungs all sit at the baseline contrast of 3.0 which the threshold rung already
        # segments — so the whole ladder costs exactly what the threshold rung alone costs.
        # Duplicates are dropped because the config is frozen and hashable.
        seen: dict[str, Config] = {}
        for st in ("threshold", "area", "elongation", "risk"):
            for c in build_configs(st):
                seen[c.label()] = c
        return list(seen.values())
    raise SystemExit(f"unknown stage '{stage}'")


def _f(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.3f}"


def _p(v: float | None) -> str:
    return "n/a" if v is None else f"{100 * v:.1f}%"


if __name__ == "__main__":
    main()
