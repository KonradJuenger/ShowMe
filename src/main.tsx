import { createRoot } from "react-dom/client";
import "./presentation.css";
import "./style.css";
import "./editor.css";
import "./frame.css";

// Each native/browser surface loads its own orchestration. They still share the
// same document platform, SlideRenderer and Effect pipeline.
const parameters = new URLSearchParams(location.search);
const role = parameters.get("present");
if (parameters.has("slidePreview")) {
  // Electron may request capture as soon as the entry script loads. Keep that
  // asynchronous API available while its canonical surface module is loading.
  window.composeSlidePreview = async (...args) => {
    const { installSlidePreviewPage } =
      await import("./components/SlidePreviewPage");
    installSlidePreviewPage();
    return window.composeSlidePreview!(...args);
  };
  window.composeEffectThumbnail = async (...args) => {
    const { installSlidePreviewPage } =
      await import("./components/SlidePreviewPage");
    installSlidePreviewPage();
    return window.composeEffectThumbnail!(...args);
  };
} else {
  const Page = parameters.has("exportPdf")
    ? (await import("./export/pdf/ExportPage")).ExportPage
    : role === "console"
      ? (await import("./components/PresenterConsole")).PresenterConsole
      : role
        ? (await import("./components/AudienceOutput")).AudienceOutput
        : (await import("./EditorApp")).EditorApp;
  createRoot(document.getElementById("root")!).render(<Page />);
}
