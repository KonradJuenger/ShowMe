import { cubicBezier } from "motion";
import type { MotionEase } from "./motionModel";
/** Shared outgoing easing for deterministic materialization and live Motion. */
export function motionEasing(ease: MotionEase = "linear") {
  if (ease === "hold") return (t: number) => (t < 1 ? 0 : 1);
  if (ease === "linear") return (t: number) => t;
  return cubicBezier(...ease);
}
export function easeProgress(t: number, ease: MotionEase = "linear") {
  return motionEasing(ease)(Math.max(0, Math.min(1, t)));
}
