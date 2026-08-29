"""Carve a reproducible train/val/test split out of the Part III dataset.

Part III is the publisher's held-out TEST split, and until now VARUNA used all 450 scenes for
evaluation only. Training on it requires cutting a genuine held-out portion first, or every
reported metric becomes a measurement of what the model memorised.

TWO PROPERTIES THIS ENFORCES:

1. Split by GEOGRAPHY, never by random tile (manifest `split_strategy`). These 450 images are
   tiles cut from a smaller number of Sentinel-1 acquisitions, so neighbouring tiles overlap
   in sea state, wind, look-alike population and often in the same slick. A random split puts
   near-duplicates on both sides and inflates test IoU without the model generalising at all.
   Whole one-degree cells are therefore assigned to exactly one side.

2. Stratify by class. An unstratified split can hand the test set very few look-alike scenes,
   and the look-alike false-positive rate is the number that matters most for this detector.

The assignment is greedy and deterministic: cells are placed largest-first into whichever
split is furthest below its per-class target. No RNG, so the split is reproducible from the
data alone and does not need a seed recorded to be audited.
"""

from __future__ import annotations

import argparse
import json
import warnings
from collections import defaultdict
from pathlib import Path

import rasterio

warnings.filterwarnings("ignore", category=rasterio.errors.NotGeoreferencedWarning)

CLASSES = {"oil": "Oil", "lookalike": "Lookalike", "no_oil": "No oil"}
TARGETS = {"train": 0.70, "val": 0.15, "test": 0.15}

#: Degrees per grouping cell. One degree is ~110 km — comfortably wider than a single
#: Sentinel-1 tile, so tiles from one acquisition land in the same cell and cannot straddle
#: the train/test boundary.
CELL_DEG = 1.0


def scan(root: Path) -> list[dict]:
    """Every image with its class and the geographic cell it belongs to."""
    out: list[dict] = []
    for key, folder in CLASSES.items():
        for img in sorted((root / "Images" / folder).glob("*.tif")):
            mask = root / "Mask" / folder / f"{img.stem}_segmentation.tif"
            if not mask.exists():
                raise FileNotFoundError(f"image without a mask: {img}")
            with rasterio.open(img) as src:
                b = src.bounds
            lon = (b.left + b.right) / 2
            lat = (b.bottom + b.top) / 2
            out.append(
                {
                    "image": str(img.relative_to(root)).replace("\\", "/"),
                    "mask": str(mask.relative_to(root)).replace("\\", "/"),
                    "cls": key,
                    "cell": [int(lon // CELL_DEG), int(lat // CELL_DEG)],
                }
            )
    return out


def assign(items: list[dict]) -> dict[str, list[dict]]:
    cells: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for it in items:
        cells[tuple(it["cell"])].append(it)

    totals = {c: sum(1 for i in items if i["cls"] == c) for c in CLASSES}
    quota = {s: {c: TARGETS[s] * totals[c] for c in CLASSES} for s in TARGETS}
    have: dict[str, dict[str, int]] = {s: {c: 0 for c in CLASSES} for s in TARGETS}
    split: dict[str, list[dict]] = {s: [] for s in TARGETS}

    # Largest cells first: a big cell placed late can no longer be balanced against.
    for _cell, group in sorted(cells.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        counts = {c: sum(1 for g in group if g["cls"] == c) for c in CLASSES}
        # Deficit = how far below target this split would still be after taking the cell.
        best = max(
            TARGETS,
            key=lambda s: sum(quota[s][c] - have[s][c] for c in CLASSES if counts[c]),
        )
        split[best].extend(group)
        for c in CLASSES:
            have[best][c] += counts[c]

    return split


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    items = scan(args.root)
    split = assign(items)

    # A cell on both sides of the split is the exact failure this module exists to prevent,
    # so it is asserted rather than trusted.
    seen: dict[tuple[int, int], str] = {}
    for name, group in split.items():
        for it in group:
            cell = tuple(it["cell"])
            if cell in seen and seen[cell] != name:
                raise AssertionError(f"cell {cell} spans {seen[cell]} and {name}")
            seen[cell] = name

    doc = {
        "dataset": "trujillo-acatitla-s1-oil-spill-part3",
        "strategy": (
            f"whole {CELL_DEG}-degree geographic cells assigned to one split, greedy "
            "largest-first against per-class targets; deterministic, no RNG"
        ),
        "targets": TARGETS,
        "cells": {name: sorted({tuple(i["cell"]) for i in g}) for name, g in split.items()},
        "counts": {
            name: {c: sum(1 for i in g if i["cls"] == c) for c in CLASSES}
            for name, g in split.items()
        },
        "items": {name: g for name, g in split.items()},
    }
    # JSON has no tuple type; cells would otherwise fail to serialise.
    doc["cells"] = {k: [list(c) for c in v] for k, v in doc["cells"].items()}

    args.out.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    print(f"\nsplit written to {args.out}\n")
    for name in ("train", "val", "test"):
        c = doc["counts"][name]
        n = sum(c.values())
        print(
            f"  {name:6} {n:3} scenes  "
            f"(oil {c['oil']:3}, look-alike {c['lookalike']:3}, oil-free {c['no_oil']:3})  "
            f"across {len(doc['cells'][name]):2} cells"
        )
    print()


if __name__ == "__main__":
    main()
