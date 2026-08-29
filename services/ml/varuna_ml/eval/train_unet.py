"""Train a small U-Net for oil-slick segmentation on the Part III train split.

M2 / M11. Trains on 315 scenes, selects on 69 validation scenes, and NEVER touches the 66
test scenes — those are scored once, by `evaluate_unet.py`, after training has finished.

WHAT THIS RUN CAN AND CANNOT SHOW, stated up front so its numbers are not over-read:

- 315 training scenes is a small dataset for segmentation. The model can learn "dark, smooth,
  elongated region on water"; it cannot learn the long tail of look-alike appearances, and
  the look-alike false-positive rate is the figure to watch rather than IoU.
- Training is CPU-only at 256x256 (see `prepare_cache`). Achievable IoU is capped by the 8x
  resampling before the model sees a pixel.
- The split is geographic, so validation and test scenes come from cells the model never
  trained on. That is what makes the reported numbers mean anything, and it also makes them
  LOWER than a random split would produce. A random split here would be flattering and wrong.

The loss is BCE + soft Dice. Slicks occupy a small minority of pixels, and BCE alone is
optimised by predicting "no oil" everywhere — which scores well on accuracy and is useless.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


def conv_block(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(cin, cout, 3, padding=1, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
        nn.Conv2d(cout, cout, 3, padding=1, bias=False),
        nn.BatchNorm2d(cout),
        nn.ReLU(inplace=True),
    )


class UNet(nn.Module):
    """A deliberately small U-Net (~0.5M parameters).

    Width is chosen for the dataset, not for the leaderboard: 315 training scenes will
    overfit a large network long before it generalises, and this has to train on CPU.
    """

    def __init__(self, in_ch: int = 2, base: int = 16) -> None:
        super().__init__()
        self.e1 = conv_block(in_ch, base)
        self.e2 = conv_block(base, base * 2)
        self.e3 = conv_block(base * 2, base * 4)
        self.bott = conv_block(base * 4, base * 8)
        self.u3 = nn.ConvTranspose2d(base * 8, base * 4, 2, stride=2)
        self.d3 = conv_block(base * 8, base * 4)
        self.u2 = nn.ConvTranspose2d(base * 4, base * 2, 2, stride=2)
        self.d2 = conv_block(base * 4, base * 2)
        self.u1 = nn.ConvTranspose2d(base * 2, base, 2, stride=2)
        self.d1 = conv_block(base * 2, base)
        self.out = nn.Conv2d(base, 1, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        e1 = self.e1(x)
        e2 = self.e2(F.max_pool2d(e1, 2))
        e3 = self.e3(F.max_pool2d(e2, 2))
        b = self.bott(F.max_pool2d(e3, 2))
        d3 = self.d3(torch.cat([self.u3(b), e3], 1))
        d2 = self.d2(torch.cat([self.u2(d3), e2], 1))
        d1 = self.d1(torch.cat([self.u1(d2), e1], 1))
        return self.out(d1)


def dice_loss(logits: torch.Tensor, target: torch.Tensor, eps: float = 1.0) -> torch.Tensor:
    p = torch.sigmoid(logits)
    num = 2 * (p * target).sum(dim=(1, 2, 3)) + eps
    den = p.sum(dim=(1, 2, 3)) + target.sum(dim=(1, 2, 3)) + eps
    return (1 - num / den).mean()


def iou_at(logits: torch.Tensor, target: torch.Tensor, thr: float = 0.5) -> tuple[float, float]:
    """(sum of intersections, sum of unions) so batches can be pooled without weighting bias."""
    p = (torch.sigmoid(logits) > thr).float()
    inter = (p * target).sum().item()
    union = ((p + target) > 0).float().sum().item()
    return inter, union


def load(cache: Path, name: str) -> tuple[torch.Tensor, torch.Tensor, np.ndarray]:
    d = np.load(cache / f"{name}.npz", allow_pickle=True)
    X = torch.from_numpy(d["X"])
    Y = torch.from_numpy(d["Y"]).float().unsqueeze(1)
    return X, Y, d["classes"]


def augment(x: torch.Tensor, y: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Flips and 90-degree rotations only.

    These are the augmentations the dataset manifest permits. They change how a scene is
    presented, never what it asserts about the world — a flipped slick is still that slick.
    Anything that pastes or synthesises content is forbidden (13_REAL_DATA_POLICY §13.3.3).
    """
    if torch.rand(1).item() < 0.5:
        x, y = torch.flip(x, [-1]), torch.flip(y, [-1])
    if torch.rand(1).item() < 0.5:
        x, y = torch.flip(x, [-2]), torch.flip(y, [-2])
    k = int(torch.randint(0, 4, (1,)).item())
    if k:
        x, y = torch.rot90(x, k, [-2, -1]), torch.rot90(y, k, [-2, -1])
    return x, y


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cache", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=3e-3)
    args = ap.parse_args()

    torch.manual_seed(1234)
    Xtr, Ytr, _ = load(args.cache, "train")
    Xva, Yva, _ = load(args.cache, "val")
    print(f"train {tuple(Xtr.shape)}  val {tuple(Xva.shape)}", flush=True)

    model = UNet()
    n_params = sum(p.numel() for p in model.parameters())
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    bce = nn.BCEWithLogitsLoss()

    best = {"val_iou": -1.0, "epoch": -1}
    history = []
    started = time.time()

    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(len(Xtr))
        tot = 0.0
        for i in range(0, len(perm), args.batch):
            idx = perm[i : i + args.batch]
            xb, yb = augment(Xtr[idx], Ytr[idx])
            opt.zero_grad()
            logits = model(xb)
            loss = bce(logits, yb) + dice_loss(logits, yb)
            loss.backward()
            opt.step()
            tot += loss.item() * len(idx)
        sched.step()

        model.eval()
        inter = union = 0.0
        with torch.no_grad():
            for i in range(0, len(Xva), args.batch):
                logits = model(Xva[i : i + args.batch])
                a, b = iou_at(logits, Yva[i : i + args.batch])
                inter += a
                union += b
        val_iou = inter / union if union else 0.0
        history.append({"epoch": epoch, "train_loss": tot / len(Xtr), "val_iou": val_iou})
        print(
            f"epoch {epoch:3}  loss {tot / len(Xtr):.4f}  val_iou {val_iou:.4f}"
            f"{'  *' if val_iou > best['val_iou'] else ''}",
            flush=True,
        )

        # Selection on VALIDATION only. Selecting on test would make the reported test score
        # an optimistic estimate of itself.
        if val_iou > best["val_iou"]:
            best = {"val_iou": val_iou, "epoch": epoch}
            args.out.parent.mkdir(parents=True, exist_ok=True)
            torch.save(model.state_dict(), args.out)

    meta = {
        "architecture": "UNet(base=16, in_ch=2)",
        "parameters": n_params,
        "epochs": args.epochs,
        "batch": args.batch,
        "lr": args.lr,
        "loss": "BCEWithLogits + soft Dice",
        "augmentation": ["hflip", "vflip", "rot90"],
        "input": "256x256, 2ch (VH,VV), Sigma0 dB clipped [-35,5] scaled [0,1]",
        "selected_epoch": best["epoch"],
        "best_val_iou": best["val_iou"],
        "train_scenes": len(Xtr),
        "val_scenes": len(Xva),
        "seconds": round(time.time() - started, 1),
        "history": history,
    }
    args.out.with_suffix(".json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(
        f"\nbest val IoU {best['val_iou']:.4f} at epoch {best['epoch']} "
        f"({n_params:,} params, {meta['seconds']:.0f}s)\n",
        flush=True,
    )


if __name__ == "__main__":
    main()
