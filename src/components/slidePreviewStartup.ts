/** Fixed production entry points, shared by preview and agent runtime surfaces. */
export const slidePreviewEntryPoints = [
  "composeSlidePreview",
  "composeEffectThumbnail",
  "measureAgentText",
  "measureAgentTextBatch",
  "validateAgentEffect",
  "prepareAgentMedia",
  "layoutHtmlExportText",
] as const;

declare global {
  interface Window {
    installAgentRuntime?: () => Promise<void>;
  }
}

export function installLazySlidePreview(install: () => Promise<void>) {
  window.installAgentRuntime = install;
  for (const name of slidePreviewEntryPoints) {
    const wrapper = async (...args: unknown[]) => {
      await install();
      const installed = window[name];
      if (!installed || installed === wrapper)
        throw new Error(
          `Production runtime entry point was not installed: ${name}`,
        );
      return Reflect.apply(installed, window, args);
    };
    Object.assign(window, { [name]: wrapper });
  }
}
