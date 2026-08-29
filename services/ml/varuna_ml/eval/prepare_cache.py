"""Cache the Part III split as small arrays so training does not re-read 15.8 GiB every epoch.

Each source scene is 2048x2048x2 float32 (~34 MB). Reading 315 of them per epoch would make
the disk, not the CPU, the thing being measured.

TWO DECISIONS RECORDED HERE BECAUSE THEY BOUND WHAT THE MODEL CAN ACHIEVE:

1. Resolution. Scenes are resampled 2048 -> 256, an 8x reduction, because this trains on CPU
   with no GPU available. A slick spanning the median 7% of a scene still covers ~4,600
   pixels at 256, so the target is far from marginal — but fine boundary detail is genuinely
   gone, and reported IoU is capped by that resampling before the model sees anything. It is
   a limit of this run, not of the approach.

2. Both polarisations are kept (VH, VV). The classical detector reads VV only; a learned
   model can use the cross-pol channel, where oil and several look-alike classes separate
   differently. Band order is (VH, VV) — measured, not what the dataset description says.

Masks are resampled with NEAREST. Any interpolation on a label would invent fractional
membership at every slick boundary and quietly relabel the pixels that matter most.
"""

from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling

warnings.filterwarnings("ignore", category=rasterio.errors.NotGeoreferencedWarning)

SIZE = 256

#: Sigma0 in dB, clipped then scaled to [0, 1]. The floor removes the long, uninformative
#: noise tail; the ceiling keeps bright land and ships from compressing everything at sea
#: into a few levels.
DB_MIN, DB_MAX = -35.0, 5.0


def load_image(path: Path, size: int = SIZE) -> np.ndarray:
    """(2, size, size) float32 in [0, 1], channel order (VH, VV)."""
    with rasterio.open(path) as src:
        arr = src.read(
            out_shape=(src.count, size, size),
            resampling=Resampling.bilinear,
        ).astype("float32")
    arr = np.clip(arr, DB_MIN, DB_MAX)
    arr = (arr - DB_MIN) / (DB_MAX - DB_MIN)
    # A scene short of two bands would silently broadcast and train on a duplicated channel.
    if arr.shape[0] != 2:
        raise ValueError(f"{path}: expected 2 bands, got {arr.shape[0]}")
    return np.nan_to_num(arr, nan=0.0)


def load_mask(path: Path, size: int = SIZE) -> np.ndarray:
    """(size, size) uint8 in {0, 1}. NEAREST only — see the module docstring."""
    with rasterio.open(path) as src:
        m = src.read(1, out_shape=(size, size), resampling=Resampling.nearest)
    return (m > 0).astype("uint8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--split", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--size", type=int, default=SIZE)
    args = ap.parse_args()

    split = json.loads(args.split.read_text(encoding="utf-8"))
    args.out.mkdir(parents=True, exist_ok=True)

    for name in ("train", "val", "test"):
        items = split["items"][name]
        X = np.zeros((len(items), 2, args.size, args.size), dtype="float32")
        Y = np.zeros((len(items), args.size, args.size), dtype="uint8")
        classes = []
        for i, it in enumerate(items):
            X[i] = load_image(args.root / it["image"], args.size)
            Y[i] = load_mask(args.root / it["mask"], args.size)
            classes.append(it["cls"])
            if (i + 1) % 25 == 0:
                print(f"  {name}: {i + 1}/{len(items)}", flush=True)

        np.savez_compressed(
            args.out / f"{name}.npz", X=X, Y=Y, classes=np.array(classes, dtype=object)
        )
        pos = float(Y.mean())
        print(
            f"{name:6} {len(items):3} scenes  X{X.shape}  positive pixels {100 * pos:.2f}%",
            flush=True,
        )


if __name__ == "__main__":
    main()
