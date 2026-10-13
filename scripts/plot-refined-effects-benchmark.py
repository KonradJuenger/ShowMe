"""Compare the retained naive strategy and refined renderer; standalone artifacts."""
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

folder = Path(__file__).resolve().parents[1] / "docs/benchmarks/mixed-effects-2026-10-13"
data = json.loads((folder / "results.json").read_text(encoding="utf-8"))
groups = {row["id"]: row for row in data["groups"]}
rows = {row["id"]: row for row in data["rows"]}
fig, axes = plt.subplots(2, 2, figsize=(12, 8), constrained_layout=True)
plt.rcParams.update({"font.size": 10})

for backend, label, color in [("native", "Naive native", "#b5473c"), ("refined", "Refined", "#216ca5")]:
    for family, axis, coordinate, xlabel in [
        ("shader", axes[0, 0], "depth", "Shader stages (image + video + text)"),
        ("composite", axes[1, 0], "depth", "Glass lenses in one layered scene"),
        ("tiles", axes[1, 1], "count", "Independent stacks, fixed total area"),
    ]:
        values = sorted([row for row in rows.values() if row["backend"] == backend and row["family"] == family and not row["heavy"] and row["profileWidth"] == 1920 and (family == "tiles" or row["count"] == 1) and groups[row["id"]]["outputMedianFps"] is not None], key=lambda row: row[coordinate])
        axis.plot([row[coordinate] for row in values], [groups[row["id"]]["outputMedianFps"] for row in values], marker="o", label=label, color=color)
        axis.set_xlabel(xlabel)
        axis.set_ylabel("Terminal publications / second")
        axis.set_ylim(bottom=0)
        axis.grid(axis="y", alpha=.2)
        axis.legend()
    values = sorted([row for row in rows.values() if row["backend"] == backend and row["family"] == "shader" and not row["heavy"] and row["profileWidth"] == 1920 and row["status"] == "ok"], key=lambda row: row["depth"])
    # The naive strategy's input textures are not instrumented. Plot measured
    # logical canvases alone so the comparison has the same accounting boundary.
    axes[0, 1].plot([row["depth"] for row in values], [row["canvasMiB"] for row in values], marker="o", label=label, color=color)

axes[0, 1].set_xlabel("Shader stages")
axes[0, 1].set_ylabel("Logical canvas bitmap MiB (excludes GPU textures)")
axes[0, 1].grid(axis="y", alpha=.2)
axes[0, 1].legend()
fig.suptitle("Electron mixed-effect renderer: same-machine comparison\nPublications include shader-clock changes; they are not unique video frames")
fig.savefig(folder / "comparison.png", dpi=180)
fig.savefig(folder / "comparison.svg")
svg = folder / "comparison.svg"
svg.write_text("\n".join(line.rstrip() for line in svg.read_text(encoding="utf-8").splitlines()) + "\n", encoding="utf-8")
