"""Score the trained U-Net on the held-out test split — M11.

Reports the SAME quantities as `detector_eval.py` does for the classical detector — oil IoU,
detection rate, and false-positive rates on look-alike and oil-free scenes — so the two are
directly comparable. A learned model that improves IoU while firing on more look-alikes is
not an improvement for this product, and only a like-for-like comparison shows that.

These 66 scenes were never trained on and never used for model selection: they come from
geographic cells absent from both the train and validation sets. The threshold is fixed at
0.5 rather than tuned here — tuning a threshold on the test set is selecting on it, and the
resulting number would be an optimistic estimate of itself.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from varuna_ml.eval.train_unet import UNet, load

THRESHOLD = 0.5


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cache", required=True, type=Path)
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--split", default="test")
    args = ap.parse_args()

    X, Y, classes = load(args.cache, args.split)
    model = UNet()
    model.load_state_dict(torch.load(args.model, map_location="cpu"))
    model.eval()

    preds = []
    with torch.no_grad():
        for i in range(0, len(X), 8):
            logits = model(X[i : i + 8])
            preds.append((torch.sigmoid(logits) > THRESHOLD).float())
    P = torch.cat(preds)

    per_scene = []
    for i in range(len(X)):
        p = P[i, 0].numpy().astype(bool)
        g = Y[i, 0].numpy().astype(bool)
        inter = int(np.logical_and(p, g).sum())
        union = int(np.logical_or(p, g).sum())
        per_scene.append(
            {
                "cls": str(classes[i]),
                "iou": (inter / union) if union else None,
                "pred_px": int(p.sum()),
                "gt_px": int(g.sum()),
                "intersection": inter,
                # A prediction of even one pixel on a look-alike or oil-free scene is a false
                # positive: those masks are entirely empty.
                "fired": bool(p.any()),
            }
        )

    def of(c: str):
        return [r for r in per_scene if r["cls"] == c]

    oil, look, none_ = of("oil"), of("lookalike"), of("no_oil")
    oil_ious = [r["iou"] for r in oil if r["iou"] is not None]

    # Pixel-pooled scores over the oil scenes. Reported alongside the per-scene mean because
    # they answer different questions: the mean weights a tiny slick and a huge one equally,
    # the pooled figure weights by area.
    tp = sum(r["intersection"] for r in oil)
    fp = sum(r["pred_px"] - r["intersection"] for r in per_scene)
    fn = sum(r["gt_px"] - r["intersection"] for r in oil)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    dice = f1  # identical for a binary mask; named both ways in the literature

    summary = {
        "split": args.split,
        "threshold": THRESHOLD,
        "counts": {"oil": len(oil), "lookalike": len(look), "no_oil": len(none_)},
        "oil": {
            "mean_iou": float(np.mean(oil_ious)) if oil_ious else None,
            "median_iou": float(np.median(oil_ious)) if oil_ious else None,
            "detection_rate": (
                (sum(1 for r in oil if r["intersection"] > 0) / len(oil)) if oil else None
            ),
            "scenes_with_no_detection": sum(1 for r in oil if not r["fired"]),
        },
        "pixel_pooled": {
            "precision": precision,
            "recall": recall,
            "f1": f1,
            "dice": dice,
        },
        "false_positives": {
            "lookalike_scene_fp_rate": (
                (sum(1 for r in look if r["fired"]) / len(look)) if look else None
            ),
            "no_oil_scene_fp_rate": (
                (sum(1 for r in none_ if r["fired"]) / len(none_)) if none_ else None
            ),
        },
        "per_scene": per_scene,
    }

    c, o, pp, f = (
        summary["counts"],
        summary["oil"],
        summary["pixel_pooled"],
        summary["false_positives"],
    )
    print(f"\nU-Net on the held-out {args.split} split")
    print(
        f"  scenes            {c['oil']} oil, {c['lookalike']} look-alike, {c['no_oil']} oil-free"
    )
    print("\n  oil segmentation")
    print(f"    mean IoU        {_f(o['mean_iou'])}")
    print(f"    median IoU      {_f(o['median_iou'])}")
    print(f"    detection rate  {_p(o['detection_rate'])}")
    print(f"    missed entirely {o['scenes_with_no_detection']} of {c['oil']}")
    print("\n  pixel-pooled")
    print(
        f"    precision {_f(pp['precision'])}   recall {_f(pp['recall'])}   F1/Dice {_f(pp['f1'])}"
    )
    print("\n  false positives (empty masks — ANY detection is wrong)")
    print(f"    look-alike      {_p(f['lookalike_scene_fp_rate'])}")
    print(f"    oil-free        {_p(f['no_oil_scene_fp_rate'])}")
    print()

    if args.out:
        args.out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(f"  written -> {args.out}\n")


def _f(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.3f}"


def _p(v: float | None) -> str:
    return "n/a" if v is None else f"{100 * v:.1f}%"


if __name__ == "__main__":
    main()
