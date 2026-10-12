import { expect, it } from "vitest";
import { createMediaElement, convertMediaRule } from "../../../src/core/media";
import { resolveMediaFrame } from "../../../src/core/element";
import type { Asset } from "../../../src/core/assets";

it("switching Fill to Free retains the visible media placement", () => {
  const asset: Asset = {
    version: 1,
    id: "a".repeat(64),
    filename: "image.png",
    names: ["image.png"],
    type: "image",
    mediaType: "image",
    mime: "image/png",
    bytes: 1,
    width: 800,
    height: 400,
    createdAt: "2026-10-09T00:00:00Z",
  };
  const element = createMediaElement("image", asset);
  element.frame.height = 640;
  const before = resolveMediaFrame(element)!;
  const free = { ...element, content: convertMediaRule(element, "free") };
  const after = resolveMediaFrame(free)!;
  expect(after.x).toBeCloseTo(before.x);
  expect(after.y).toBeCloseTo(before.y);
  expect(after.width).toBeCloseTo(before.width);
  expect(after.height).toBeCloseTo(before.height);
  expect(free.content).toMatchObject({
    assetId: asset.id,
    transform: { rule: "free" },
  });
});
