"""Standalone benchmark plots. Requires matplotlib; reads committed results.json."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

folder = Path(__file__).resolve().parents[1] / "docs/benchmarks/mixed-effects-2026-10-12"
data = json.loads((folder / "results.json").read_text(encoding="utf-8"))
groups = {row["id"]: row for row in data["groups"]}
rows = {row["id"]: row for row in data["rows"]}
plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
fig, axes = plt.subplots(2, 2, figsize=(12, 8), constrained_layout=True)

def series(ax, label, predicate, coordinate, color):
    selected = sorted([row for row in rows.values() if predicate(row) and groups[row["id"]]["outputMedianFps"] is not None], key=coordinate)
    x = [coordinate(row) for row in selected]
    y = [groups[row["id"]]["outputMedianFps"] for row in selected]
    lower = [value-groups[row["id"]]["outputMinFps"] for row, value in zip(selected, y)]
    upper = [groups[row["id"]]["outputMaxFps"]-value for row, value in zip(selected, y)]
    ax.errorbar(x, y, yerr=[lower, upper], marker="o", label=label, color=color, capsize=3)
    ax.grid(axis="y", alpha=.2)
    ax.set_ylabel("Terminal shader publications / second")

normal = lambda row: row["count"] == 1 and row["videoCount"] == 1 and row["profileWidth"] == 1920
for backend, color in [("native", "#b94c30"), ("gpu", "#197e9c")]:
    series(axes[0,0], backend, lambda row: normal(row) and row["family"] == "shader" and not row["heavy"] and row["backend"] == backend, lambda row: row["depth"], color)
axes[0,0].set_title("Consecutive shader stages")
axes[0,0].set_xlabel("Shader depth (groups beyond 16)")
axes[0,0].set_xscale("log", base=2)
axes[0,0].legend()

series(axes[0,1], "Full-frame backdrop lenses", lambda row: row["family"] == "backdrop", lambda row: row["count"], "#a065ab")
series(axes[0,1], "Layered scene + glass + CSS", lambda row: normal(row) and row["family"] == "composite", lambda row: row["depth"], "#197e9c")
axes[0,1].set_title("Overlapping effect elements")
axes[0,1].set_xlabel("Lenses in one scene")
axes[0,1].set_xscale("log", base=2)
axes[0,1].legend()

series(axes[1,0], "Fixed total area, four mixed stages", lambda row: row["family"] == "tiles", lambda row: row["count"], "#b94c30")
axes[1,0].set_title("Per-element overhead")
axes[1,0].set_xlabel("Tiles")
axes[1,0].set_xscale("log", base=2)

series(axes[1,1], "Four GPU stages, 1080p", lambda row: normal(row) and row["family"] == "shader" and row["depth"] == 4 and row["heavy"] and row["backend"] == "gpu", lambda row: row.get("taps", 32), "#197e9c")
axes[1,1].set_title("Increasing texture sampling work")
axes[1,1].set_xlabel("Samples per shader pixel")
axes[1,1].set_xscale("log", base=2)
fig.suptitle("ShowMe / Electron 44.4.1 / RTX 2080 Ti — measured limits", fontsize=15)
for ax, ticks in zip(axes.flat, [[1,2,4,8,16,32],[1,2,4,8],[1,4,16,64],[32,128,512,1024]]):
    ax.set_ylim(0,max(1,ax.dataLim.ymax)*1.1)
    ax.set_xticks(ticks,labels=[str(value) for value in ticks])
    ax.minorticks_off()
fig.savefig(folder / "limits.svg")
# Matplotlib emits trailing spaces in multiline SVG paths. Preserve the path
# separators/newlines while keeping the committed generated artifact clean.
svg = folder / "limits.svg"
svg.write_text("\n".join(line.rstrip() for line in svg.read_text(encoding="utf-8").splitlines()) + "\n", encoding="utf-8")
fig.savefig(folder / "limits.png", dpi=160)
print(folder / "limits.svg")
