import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PresentationDisplaySetup } from "../../src/components/PresentationDisplaySetup";
import {
  resolvePresentationDisplays,
  type PresentationDisplayAssignment,
} from "../../src/core/presentationDisplays";
import "../../src/editor.css";
import "../../src/modernTheme.css";

const screens = [
  {
    id: 7,
    label: "Laptop",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    primary: true,
    scaleFactor: 1,
  },
  {
    id: 8,
    label: "Projector",
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    primary: false,
    scaleFactor: 2,
  },
  {
    id: 9,
    label: "Monitor",
    bounds: { x: 3840, y: 0, width: 1920, height: 1080 },
    primary: false,
    scaleFactor: 1,
  },
];
export function mountPresentationDisplaysHarness() {
  function Harness() {
    const [assignment, setAssignment] =
      useState<PresentationDisplayAssignment | null>(null);
    const [active, setActive] = useState(false);
    const current = resolvePresentationDisplays(screens, 7, assignment);
    return (
      <main
        style={{ display: "flex", justifyContent: "flex-end", padding: 16 }}
      >
        <PresentationDisplaySetup
          displays={screens.map((display) => ({
            ...display,
            audience: display.id === current.audienceDisplayId,
            presenter: display.id === current.presenterDisplayId,
          }))}
          onAssign={async (value) => setAssignment(value)}
          disabled={active}
        />
        <button onClick={() => setActive((value) => !value)}>
          {active ? "End" : "Present"}
        </button>
      </main>
    );
  }
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  createRoot(host).render(<Harness />);
}
