import { acquireVideoPlayer, videoPlayerKey } from "./preparedVideoPool";
import { resolveTextTypography } from "../core/textTypography";
import type { EffectClockOrigins } from "../core/effectClocks";
import { resolveVisualSlide } from "../core/templates";
import { usePreparedImage } from "./usePreparedImage";
import { useSlideImagePlan, type SlideImagePlan } from "./useSlideImagePlan";
import { type ImageOutputProfile } from "../core/presentationImages";
import type { MotionPreviewState } from "../core/motionPlayback";
import { useMotionRuntime } from "./useMotionRuntime";
import { EffectSurface } from "./EffectSurface";
import { nativeOpacityPlan, type NativeOpacity } from "./nativeOpacity";
import type { EffectResources } from "../core/effects";
import {
  compileCompositionPlan,
  compositionIsOwnedMediaOnly,
  type Composition,
  type CompositionPlan,
} from "./compositionPlan";
import {
  memo,
  Fragment,
  createContext,
  useMemo,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Deck, Slide } from "../core/document";
import {
  frameCssTransform,
  frameCssOrigin,
  resolveMediaFrame,
  type Element,
  type MediaContent,
} from "../core/element";
import { locateElement, layerRoots } from "../core/scene";
import { captureVideoPoster, videoPoster } from "../core/videoPoster";
import { videoBounds } from "../core/video";
import { useAssetUrl } from "./useAssetUrl";
import { useRenderResources } from "./renderResources";
import { useDisplayDensity } from "./useDisplayDensity";
import { EffectRenderContext } from "./EffectRenderContext";
import {
  liveRenderProfile,
  renderDensity,
  shaderScaleEnvelopes,
  type RenderScale,
  type SlideRenderProfile,
} from "../core/renderProfile";

const SceneTextureSceneContext = createContext<{
  current: { slide: Slide; deck: Deck };
} | null>(null);
const VideoPreparationContext = createContext(false);
const TextStylesContext = createContext<Deck | undefined>(undefined);
const EffectResourcesContext = createContext<EffectResources>({});
const emptyEffectResources: EffectResources = {};
const ImageDocumentContext = createContext<{
  documentId: string;
  slideId: string;
  profile?: ImageOutputProfile;
  deferUpdates: boolean;
  plan?: SlideImagePlan;
} | null>(null);

type VideoContent = Extract<MediaContent, { type: "video" }>;
export type EditorPlayback = "inactive" | "preview" | "trim";

function VideoView({
  playerKey,
  content,
  url,
  previewUrl,
  staticVideo,
  presentation,
  editorPlayback,
  onSize,
  onError,
}: {
  playerKey: string;
  content: VideoContent;
  url: string | null | undefined;
  previewUrl: string | null | undefined;
  staticVideo: boolean;
  presentation: boolean;
  editorPlayback?: EditorPlayback;
  onSize: (size: { width: number; height: number }) => void;
  onError: () => void;
}) {
  const resources = useRenderResources();
  const video = useRef<HTMLVideoElement>(null);
  const videoHost = useRef<HTMLDivElement>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  const prepareVideo = useContext(VideoPreparationContext);
  const activePlayback = !staticVideo && editorPlayback !== "inactive";
  const loadVideo = activePlayback || prepareVideo;
  const editorPreview = editorPlayback === "preview";
  useLayoutEffect(() => {
    if (!loadVideo || !videoHost.current) return;
    const player = acquireVideoPlayer(playerKey, content.assetId, resources);
    video.current = player.node;
    videoHost.current.append(player.node);
    return () => {
      video.current = null;
      player.release();
    };
  }, [playerKey, content.assetId, loadVideo, resources]);
  const editorInactive = editorPlayback === "inactive";
  const posterKey = `${content.assetId}:${content.startTime}`;
  const [poster, setPoster] = useState<{
    key: string;
    url: string | null;
  } | null>(null);
  const [presented, setPresented] = useState(false);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  useEffect(() => {
    // Reuse cached posters; playback and warmup capture missing frames below.
    let live = true;
    void videoPoster(
      resources,
      content.assetId,
      content.startTime,
      !loadVideo,
    ).then((url) => {
      if (live) setPoster({ key: posterKey, url });
    });
    return () => {
      live = false;
    };
  }, [content.assetId, content.startTime, posterKey, loadVideo, resources]);

  // Keep the prepared element and source when the upcoming slide becomes active.
  useEffect(() => {
    const node = video.current;
    if (!node || url === undefined) return;
    setReady(false);
    setPresented(false);
    setIsPlaying(false);
    setAutoplayBlocked(false);
    if (!loadVideo || !url) {
      node.pause();
      node.removeAttribute("src");
      node.load();
      return;
    }
    let live = true;
    let metadataLoaded = false;
    let capturedStart: number | null = null;
    let submittedTime: number | null = null;
    let videoFrame = 0;
    let paintFrame = 0;
    const atStart = () => {
      const { start } = videoBounds(contentRef.current, node.duration);
      return (
        metadataLoaded &&
        !node.seeking &&
        node.readyState >= 2 &&
        node.currentTime + 0.001 >= start
      );
    };
    const framePresented: VideoFrameRequestCallback = (_now, frame) => {
      if (!live) return;
      submittedTime = frame.mediaTime;
      const { start } = videoBounds(contentRef.current, node.duration);
      if (atStart() && frame.mediaTime + 0.05 >= start) setPresented(true);
      else videoFrame = node.requestVideoFrameCallback(framePresented);
    };
    const decoded = () => {
      if (!atStart()) return;
      const current = contentRef.current;
      const { start } = videoBounds(current, node.duration);
      if (
        capturedStart !== current.startTime &&
        Math.abs(node.currentTime - start) < 0.001
      ) {
        const url = captureVideoPoster(
          current.assetId,
          current.startTime,
          node,
          resources,
        );
        if (url) {
          capturedStart = current.startTime;
          setPoster({ key: `${current.assetId}:${current.startTime}`, url });
        }
      }
      setReady(true);
      // Chromium can submit the sought frame before firing seeked. A paused
      // player may produce no further callback after seeked, so retain that signal.
      if (
        submittedTime !== null &&
        Math.abs(submittedTime - node.currentTime) < 0.05
      )
        setPresented(true);
      if (!("requestVideoFrameCallback" in node)) {
        paintFrame = requestAnimationFrame(() => {
          paintFrame = requestAnimationFrame(() => {
            if (live && atStart()) setPresented(true);
          });
        });
      }
    };
    const metadata = () => {
      metadataLoaded = true;
      if (node.videoWidth && node.videoHeight)
        onSize({ width: node.videoWidth, height: node.videoHeight });
      const { start } = videoBounds(contentRef.current, node.duration);
      if (Math.abs(node.currentTime - start) > 0.001) node.currentTime = start;
      else decoded();
    };
    node.addEventListener("loadedmetadata", metadata);
    node.addEventListener("loadeddata", decoded);
    node.addEventListener("seeked", decoded);
    if ("requestVideoFrameCallback" in node)
      videoFrame = node.requestVideoFrameCallback(framePresented);
    if (node.src && node.readyState >= 1) {
      metadata();
      decoded();
      paintFrame = requestAnimationFrame(() => {
        paintFrame = requestAnimationFrame(() => {
          if (live && atStart()) setPresented(true);
        });
      });
    } else {
      node.src = url;
      node.load();
    }
    return () => {
      live = false;
      if (videoFrame) node.cancelVideoFrameCallback(videoFrame);
      cancelAnimationFrame(paintFrame);
      node.removeEventListener("loadedmetadata", metadata);
      node.removeEventListener("loadeddata", decoded);
      node.removeEventListener("seeked", decoded);
      node.pause();
    };
  }, [url, loadVideo, onSize, resources]);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    if (!activePlayback) {
      node.pause();
      if (loadVideo && node.readyState >= 1) {
        const { start } = videoBounds(contentRef.current, node.duration);
        if (Math.abs(node.currentTime - start) > 0.001) {
          setReady(false);
          node.currentTime = start;
        }
      }
      return;
    }
    if (ready && contentRef.current.autoplay && editorPlayback !== "trim")
      void node.play().then(
        () => setAutoplayBlocked(false),
        () => setAutoplayBlocked(true),
      );
  }, [activePlayback, loadVideo, ready, editorPlayback]);

  const previousTrim = useRef({
    start: content.startTime,
    end: content.endTime,
  });
  useEffect(() => {
    const previous = previousTrim.current;
    previousTrim.current = { start: content.startTime, end: content.endTime };
    const node = video.current;
    if (!node || node.readyState < 1 || !loadVideo || editorPlayback === "trim")
      return;
    if (
      previous.start === content.startTime &&
      previous.end === content.endTime
    )
      return;
    const { start, end } = videoBounds(content, node.duration);
    node.pause();
    if (!activePlayback) {
      setReady(false);
      node.currentTime = start;
      return;
    }
    node.currentTime =
      previous.start !== content.startTime
        ? start
        : Math.min(end, node.duration - 0.01);
  }, [content, activePlayback, loadVideo, editorPlayback]);

  const enforceEnd = useCallback((node: HTMLVideoElement) => {
    if (node.paused) return;
    const current = contentRef.current;
    const { start, end } = videoBounds(current, node.duration);
    if (node.currentTime + 0.025 < end) return;
    if (!current.loop) node.pause();
    node.currentTime = start;
    if (current.loop) void node.play().catch(() => {});
  }, []);

  useEffect(() => {
    const node = video.current;
    if (!node || !activePlayback) return;
    let frame = 0;
    const tick = () => {
      enforceEnd(node);
      if (!node.paused) frame = requestAnimationFrame(tick);
    };
    const play = () => {
      const { start, end } = videoBounds(contentRef.current, node.duration);
      if (node.currentTime < start || node.currentTime + 0.025 >= end)
        node.currentTime = start;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    node.addEventListener("play", play);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("play", play);
    };
  }, [activePlayback, enforceEnd]);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    node.volume = content.volume;
  }, [content.volume, activePlayback]);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    node.dataset.assetId = content.assetId;
    node.muted = content.mute;
    node.volume = content.volume;
    node.controls =
      editorPreview ||
      (!presentation && editorPlayback === undefined && !content.autoplay);
    Object.assign(node.style, {
      display: "block",
      width: "100%",
      height: "100%",
      objectFit: "fill",
      visibility: activePlayback ? "visible" : "hidden",
    });
    const play = () => {
        setIsPlaying(true);
        if (content.autoplay) setAutoplayBlocked(false);
      },
      pause = () => setIsPlaying(false);
    const update = () => enforceEnd(node);
    const ended = () => {
      if (content.loop) {
        node.currentTime = videoBounds(content, node.duration).start;
        void node.play().catch(() => {});
      }
    };
    node.addEventListener("play", play);
    node.addEventListener("pause", pause);
    node.addEventListener("timeupdate", update);
    node.addEventListener("ended", ended);
    node.addEventListener("error", onError);
    return () => {
      node.removeEventListener("play", play);
      node.removeEventListener("pause", pause);
      node.removeEventListener("timeupdate", update);
      node.removeEventListener("ended", ended);
      node.removeEventListener("error", onError);
    };
  }, [
    content,
    activePlayback,
    editorPreview,
    presentation,
    editorPlayback,
    enforceEnd,
    onError,
    loadVideo,
  ]);

  const posterUrl =
    (poster?.key === posterKey ? poster.url : null) ||
    (content.startTime === 0 ? previewUrl : null);
  return (
    <div
      data-media-loading={loadVideo && !ready ? "true" : undefined}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      {(editorInactive || !presented || staticVideo) && posterUrl && (
        <img
          data-video-poster-time={content.startTime}
          src={posterUrl}
          alt=""
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth && image.naturalHeight)
              onSize({
                width: image.naturalWidth,
                height: image.naturalHeight,
              });
          }}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            pointerEvents: "none",
            width: "100%",
            height: "100%",
            objectFit: "fill",
          }}
        />
      )}
      {loadVideo && (
        <div ref={videoHost} style={{ width: "100%", height: "100%" }} />
      )}
      {presentation &&
        !staticVideo &&
        ready &&
        (!content.autoplay || autoplayBlocked) && (
          <button
            className="movie-click-to-play"
            style={{ zIndex: 2 }}
            aria-label={isPlaying ? "Pause video" : "Play video"}
            onClick={(event) => {
              event.stopPropagation();
              const node = video.current;
              if (!node) return;
              if (node.paused) void node.play().catch(() => {});
              else node.pause();
            }}
          >
            {isPlaying ? "Ⅱ" : "▶"}
          </button>
        )}
    </div>
  );
}

function MissingMediaPlaceholder() {
  return (
    <svg
      data-missing-media="true"
      role="img"
      aria-label="Missing asset"
      width="100%"
      height="100%"
      style={{ display: "block", borderRadius: "inherit", overflow: "hidden" }}
    >
      <rect width="100%" height="100%" fill="#d8d8d4" />
      <g stroke="#b6b6b2" strokeWidth="4">
        <line x1="0" y1="0" x2="100%" y2="100%" />
        <line x1="100%" y1="0" x2="0" y2="100%" />
        <rect
          x="2"
          y="2"
          style={{ width: "calc(100% - 4px)", height: "calc(100% - 4px)" }}
          fill="none"
        />
      </g>
      <rect
        x="50%"
        y="50%"
        width="154"
        height="38"
        rx="4"
        fill="#d8d8d4"
        transform="translate(-77 -19)"
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="middle"
        textAnchor="middle"
        fill="#5f5f5b"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="20"
        fontWeight="500"
        letterSpacing="0.4"
      >
        content missing
      </text>
    </svg>
  );
}

function MediaView({
  element,
  staticVideo,
  presentation,
  editorPlayback,
}: {
  element: Element;
  staticVideo: boolean;
  presentation: boolean;
  editorPlayback?: EditorPlayback;
}) {
  const content = element.content;
  if (!content || content.type === "text") return null;
  return (
    <MediaSurface
      element={element}
      content={content}
      staticVideo={staticVideo}
      presentation={presentation}
      editorPlayback={editorPlayback}
    />
  );
}

function MediaSurface({
  element,
  content,
  staticVideo,
  presentation,
  editorPlayback,
}: {
  element: Element;
  content: MediaContent;
  staticVideo: boolean;
  presentation: boolean;
  editorPlayback?: EditorPlayback;
}) {
  const [intrinsic, setIntrinsic] = useState<{
    width: number;
    height: number;
  }>();
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [decodedUrl, setDecodedUrl] = useState<string | null>(null);
  const onSize = useCallback(
    (size: { width: number; height: number }) =>
      setIntrinsic((old) =>
        old?.width === size.width && old.height === size.height ? old : size,
      ),
    [],
  );
  const imageDocument = useContext(ImageDocumentContext);
  const { image: prepared, checking } = usePreparedImage(
    imageDocument?.documentId ?? null,
    imageDocument?.slideId ?? "",
    element.id,
    content.assetId,
    content.type === "image",
    imageDocument?.profile,
    imageDocument?.deferUpdates,
    imageDocument?.plan,
  );
  const [failedPreparedUrl, setFailedPreparedUrl] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (checking) setFailedPreparedUrl(null);
  }, [checking]);
  const displayPrepared =
    prepared && prepared.url !== failedPreparedUrl ? prepared : null;
  const originalUrl = useAssetUrl(
    content.assetId,
    false,
    prepared !== undefined && !displayPrepared,
  );
  const url =
    prepared === undefined ? undefined : (displayPrepared?.url ?? originalUrl);
  const previewUrl = useAssetUrl(
    content.assetId,
    true,
    content.type === "video",
  );

  const mediaSource = `${url}:${previewUrl}`;
  const failed = failedSource === mediaSource;

  useEffect(() => {
    if (
      !url ||
      content.transform.rule === "free" ||
      (content.transform.intrinsicWidth && content.transform.intrinsicHeight)
    )
      return;
    if (content.type === "video") {
      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        if (probe.videoWidth && probe.videoHeight)
          onSize({ width: probe.videoWidth, height: probe.videoHeight });
      };
      probe.src = url;
      return () => {
        probe.pause();
        probe.removeAttribute("src");
        probe.load();
      };
    }
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.onload = () => {
      if (probe.naturalWidth && probe.naturalHeight)
        onSize({
          width: prepared?.sourceWidth ?? probe.naturalWidth,
          height: prepared?.sourceHeight ?? probe.naturalHeight,
        });
    };
    probe.onerror = () => {
      if (displayPrepared) setFailedPreparedUrl(displayPrepared.url);
      else setFailedSource(mediaSource);
    };
    probe.src = url;
    return () => {
      probe.onload = null;
      probe.onerror = null;
      probe.src = "";
    };
  }, [
    url,
    content.type,
    content.transform,
    onSize,
    prepared,
    displayPrepared,
    mediaSource,
  ]);

  const frame = resolveMediaFrame(
    element,
    prepared
      ? { width: prepared.sourceWidth, height: prepared.sourceHeight }
      : intrinsic,
  );
  if (!checking && (failed || url === null)) return <MissingMediaPlaceholder />;
  if (!frame) return <div data-media-loading="true" />;

  const style: CSSProperties = {
    position: "absolute",
    left: frame.x,
    top: frame.y,
    width: frame.width,
    height: frame.height,
    transform: frameCssTransform(frame),
    transformOrigin: frameCssOrigin(frame),
    opacity: content.opacity,
  };

  return (
    <div
      data-showme-part="content"
      data-media-asset-id={content.assetId}
      data-media-type={content.type}
      data-media-loading={
        url === undefined ||
        checking ||
        (content.type !== "video" && decodedUrl !== url)
          ? "true"
          : undefined
      }
      style={style}
    >
      {content.type === "video" ? (
        <VideoView
          playerKey={videoPlayerKey(
            imageDocument?.documentId ?? "editor",
            imageDocument?.slideId ?? "slide",
            element.id,
          )}
          content={content}
          url={url}
          previewUrl={previewUrl}
          staticVideo={staticVideo}
          presentation={presentation}
          editorPlayback={editorPlayback}
          onSize={onSize}
          onError={() => setFailedSource(mediaSource)}
        />
      ) : (
        url && (
          <img
            src={url}
            crossOrigin="anonymous"
            decoding="async"
            data-source-width={displayPrepared?.sourceWidth}
            data-source-height={displayPrepared?.sourceHeight}
            alt=""
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget;
              const source = url;
              void image
                .decode()
                .then(() => {
                  if (image.isConnected && image.getAttribute("src") === source)
                    setDecodedUrl(source);
                })
                .catch(() => {
                  if (
                    !image.isConnected ||
                    image.getAttribute("src") !== source
                  )
                    return;
                  if (displayPrepared)
                    setFailedPreparedUrl(displayPrepared.url);
                  else setFailedSource(mediaSource);
                });
              if (image.naturalWidth && image.naturalHeight)
                onSize({
                  width: prepared?.sourceWidth ?? image.naturalWidth,
                  height: prepared?.sourceHeight ?? image.naturalHeight,
                });
            }}
            onError={() => {
              if (displayPrepared) setFailedPreparedUrl(displayPrepared.url);
              else setFailedSource(mediaSource);
            }}
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              objectFit: "fill",
            }}
          />
        )
      )}
    </div>
  );
}

function TextView({
  content: authored,
}: {
  content: Extract<NonNullable<Element["content"]>, { type: "text" }>;
}) {
  const source = useContext(TextStylesContext);
  const content = { ...authored, ...resolveTextTypography(source, authored) };
  const justifyContent =
    content.verticalAlign === "middle"
      ? "center"
      : content.verticalAlign === "bottom"
        ? "flex-end"
        : "flex-start";
  return (
    <div
      data-showme-part="content"
      data-text-content="true"
      data-text-placeholder={content.placeholder ? "true" : undefined}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent,
        fontFamily: content.fontFamily,
        fontWeight: content.bold
          ? Math.max(700, content.fontWeight)
          : content.fontWeight,
        fontStyle: content.italic ? "italic" : "normal",
        fontSize: content.fontSize,
        color: content.color,
        textAlign: content.align,
        lineHeight: content.lineHeight,
        letterSpacing: content.letterSpacing,
        whiteSpace: content.autoSize === "both" ? "pre" : "pre-wrap",
        overflowWrap: content.autoSize === "both" ? "normal" : "anywhere",
      }}
    >
      {content.text}
    </div>
  );
}

const ElementView = memo(function ElementView({
  element,
  staticVideo,
  presentation,
  editorPlayback,
  editingTextId,
  inherited = false,
  composition,
  opacityPlan,
}: {
  element: Element;
  staticVideo: boolean;
  presentation: boolean;
  editorPlayback?: EditorPlayback;
  editingTextId?: string | null;
  inherited?: boolean;
  composition: CompositionPlan;
  opacityPlan: ReadonlyMap<string, NativeOpacity>;
}) {
  const { frame, appearance } = element;
  const resources = useContext(EffectResourcesContext);
  const effectRender = useContext(EffectRenderContext);
  const scene = useContext(SceneTextureSceneContext);
  const group = composition.groups.get(element.id)!;
  const alpha = opacityPlan.get(element.id);
  const sceneTextureSource = useMemo(
    () => ({
      element,
      resources: scene?.current.slide.effectResources ?? emptyEffectResources,
      scene: scene ? () => scene.current : undefined,
    }),
    [element, scene],
  );
  const surface = (
    instance: NonNullable<Element["effects"]>[number],
    children?: ReactNode,
    opacity?: string,
    directShaderInput = false,
    ownedMediaInput = false,
  ) => (
    <EffectSurface
      // A saved definition has a new immutable resource identity. Give it a
      // fresh surface so the outgoing runtime cannot repaint its old canvas.
      key={`${instance.id}:${instance.resourceId}`}
      definition={resources[instance.resourceId]}
      instance={instance}
      width={frame.width}
      height={frame.height}
      samplingEnvelope={effectRender?.envelopes?.get(element.id)}
      nativeOpacity={opacity}
      directShaderInput={directShaderInput}
      ownedMediaInput={ownedMediaInput}
      sceneTextureSource={
        resources[instance.resourceId].kind === "fragment-glsl"
          ? sceneTextureSource
          : undefined
      }
      textContent={
        resources[instance.resourceId].kind === "text-js" &&
        element.content?.type === "text"
          ? element.content
          : undefined
      }
    >
      {children}
    </EffectSurface>
  );
  const source = (
    <>
      {element.content?.type === "text" && element.id !== editingTextId && (
        <TextView content={element.content} />
      )}
      {element.content && element.content.type !== "text" && (
        <MediaView
          element={element}
          staticVideo={staticVideo}
          presentation={presentation}
          editorPlayback={editorPlayback}
        />
      )}
    </>
  );
  const children = element.children.map((child) => (
    <ElementView
      key={child.id}
      element={child}
      staticVideo={staticVideo}
      presentation={presentation}
      editorPlayback={editorPlayback}
      editingTextId={editingTextId}
      composition={composition}
      opacityPlan={opacityPlan}
    />
  ));
  const shape = element.geometry.type === "ellipse" ? "50%" : appearance.radius;
  const outline: CSSProperties = {
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    borderRadius: shape,
    border:
      appearance.strokeWidth > 0
        ? `${appearance.strokeWidth}px solid ${appearance.strokeColor}`
        : undefined,
    pointerEvents: "none",
  };

  const lower = (operation: Composition, opacity?: string): ReactNode => {
    switch (operation.kind) {
      case "source":
        if (!element.content) return null;
        return opacity ? (
          <div style={{ position: "absolute", inset: 0, opacity }}>
            {source}
          </div>
        ) : (
          source
        );
      case "children":
        return children;
      case "effect": {
        const definition = resources[operation.effect.resourceId];
        const directShaderInput =
          !opacity &&
          !scene?.current.deck.stylesheet?.trim() &&
          definition?.kind === "fragment-glsl" &&
          definition.input === "content" &&
          operation.input?.kind === "effect" &&
          resources[operation.input.effect.resourceId]?.kind ===
            "fragment-glsl";
        const ownedMediaInput =
          !opacity &&
          !scene?.current.deck.stylesheet?.trim() &&
          definition?.kind === "fragment-glsl" &&
          definition.input === "content" &&
          !!operation.input &&
          compositionIsOwnedMediaOnly(operation.input, element);
        return surface(
          operation.effect,
          operation.input ? lower(operation.input) : undefined,
          opacity,
          directShaderInput,
          ownedMediaInput,
        );
      }
      case "sequence":
        return operation.items.map((item, index) => (
          <Fragment key={index}>{lower(item, opacity)}</Fragment>
        ));
      case "clip":
        return (
          <div
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              borderRadius: shape,
              overflow: element.clipChildren ? "hidden" : "visible",
            }}
          >
            {lower(operation.input, opacity)}
          </div>
        );
      case "fill":
        return (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: appearance.fill ?? undefined,
              opacity,
              borderRadius: shape,
            }}
          />
        );
      case "stroke":
        return (
          <div
            data-element-stroke="true"
            aria-hidden="true"
            style={{ ...outline, opacity }}
          />
        );
    }
  };

  return (
    <div
      data-element-id={element.id}
      data-native-opacity={alpha?.property}
      data-template-content={inherited ? "true" : undefined}
      data-showme-id={`showme-${element.id}`}
      data-showme-part="self"
      className={element.cssClasses?.join(" ")}
      style={
        {
          position: "absolute",
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          transform: frameCssTransform(frame),
          transformOrigin: frameCssOrigin(frame),
          ...(alpha ? { [alpha.property]: appearance.opacity } : {}),
          opacity: alpha
            ? alpha.distribute
              ? 1
              : alpha.value
            : appearance.opacity,
        } as CSSProperties
      }
    >
      {lower(group.visual, alpha?.distribute ? alpha.value : undefined)}
    </div>
  );
});

/** Canonical renderer shared by the production editor and previews. */
export const SlideRenderer = memo(function SlideRenderer({
  slide: localSlide,
  deck,
  templates,
  staticVideo = false,
  presentation = false,
  editorPlayback,
  editingTextId = null,
  editingMediaId = null,
  editorOverflow = false,
  motionState,
  preparedImages = presentation,
  imageProfile,
  renderScale = 1,
  renderProfile,
  deferImageUpdates = false,
  prepareVideo = false,
  effectClock,
  visualPlayback = "live",
}: {
  slide: Slide;
  deck: Deck;
  templates?: Record<string, import("../core/document").TemplatePage>;
  staticVideo?: boolean;
  presentation?: boolean;
  editorPlayback?: EditorPlayback;
  editingTextId?: string | null;
  editingMediaId?: string | null;
  editorOverflow?: boolean;
  motionState?: MotionPreviewState | null;
  preparedImages?: boolean;
  imageProfile?: ImageOutputProfile;
  renderScale?: RenderScale;
  renderProfile?: SlideRenderProfile;
  deferImageUpdates?: boolean;
  prepareVideo?: boolean;
  effectClock?: EffectClockOrigins;
  visualPlayback?: "live" | "static";
}) {
  const resolved = useMemo(
    () => (templates ? resolveVisualSlide(deck, localSlide, templates) : null),
    [deck, localSlide, templates],
  );
  const slide = resolved?.slide ?? localSlide;
  const editingMedia = editingMediaId
    ? locateElement(slide, editingMediaId)
    : null;
  const compositionResources = slide.effectResources;
  const composition = useMemo(
    () =>
      compileCompositionPlan(slide, deck, editingTextId, compositionResources),
    [slide, deck, compositionResources, editingTextId],
  );
  const root = useRef<HTMLDivElement>(null);
  const opacityPlan = useMemo(
    () =>
      nativeOpacityPlan(
        slide.nodes.flatMap((node) => node.children),
        compositionResources ?? {},
        deck.stylesheet,
      ),
    [slide, compositionResources, deck.stylesheet],
  );
  const pixelRatio = useDisplayDensity();
  const width = deck.width,
    height = deck.height;
  const scaleX = typeof renderScale === "number" ? renderScale : renderScale.x;
  const scaleY = typeof renderScale === "number" ? renderScale : renderScale.y;
  const output = useMemo(
    () =>
      renderProfile ??
      liveRenderProfile(
        { width, height },
        { x: scaleX, y: scaleY },
        pixelRatio,
      ),
    [renderProfile, width, height, scaleX, scaleY, pixelRatio],
  );
  const playing =
    motionState?.running ??
    (!!effectClock && effectClock.pausedAt === undefined);
  const stageIndex = motionState?.stageIndex ?? effectClock?.stepIndex ?? 0;
  const envelopes = useMemo(
    () => (playing ? shaderScaleEnvelopes(slide, stageIndex) : undefined),
    [playing, slide, stageIndex],
  );
  const effectRender = useMemo(
    () => ({
      density: renderDensity({ width, height }, output),
      root,
      retain: deferImageUpdates || playing,
      envelopes,
      staticFrame: visualPlayback === "static",
      sceneRevision: slide,
      deckRevision: deck,
    }),
    [
      width,
      height,
      output,
      deferImageUpdates,
      playing,
      envelopes,
      visualPlayback,
      slide,
      deck,
    ],
  );
  useMotionRuntime(
    root,
    slide,
    motionState,
    !!effectClock || !staticVideo,
    effectClock,
    undefined,
    undefined,
    visualPlayback === "static",
  );
  const rasterScene = useRef({ slide, deck });
  rasterScene.current = { slide, deck };
  const layers = new Map(deck.layers.map((layer) => [layer.id, layer]));
  // Live editor and preview surfaces share the audience variants. Only explicit
  // output profiles (audience negotiation and export) override that default.
  const imagePlan = useSlideImagePlan(
    slide,
    deck,
    imageProfile,
    preparedImages,
    deferImageUpdates,
  );
  const imageContext = useMemo(
    () =>
      preparedImages
        ? {
            documentId: deck.id,
            slideId: slide.id,
            deferUpdates: deferImageUpdates,
            profile: imageProfile,
            plan: imagePlan,
          }
        : null,
    [
      preparedImages,
      deck.id,
      slide.id,
      deferImageUpdates,
      imageProfile,
      imagePlan,
    ],
  );
  return (
    <EffectRenderContext.Provider value={effectRender}>
      <EffectResourcesContext.Provider
        value={slide.effectResources ?? emptyEffectResources}
      >
        <SceneTextureSceneContext.Provider value={rasterScene}>
          <TextStylesContext.Provider value={deck}>
            <VideoPreparationContext.Provider value={prepareVideo}>
              <ImageDocumentContext.Provider value={imageContext}>
                <div
                  ref={root}
                  className="slide-renderer"
                  data-visual-playback={visualPlayback}
                  data-slide-id={slide.id}
                  style={{
                    position: "relative",
                    width: deck.width,
                    height: deck.height,
                    background: slide.background,
                    overflow: editorOverflow ? "visible" : "hidden",
                  }}
                >
                  {deck.stylesheet && (
                    <style>{`@scope (.slide-renderer) { ${deck.stylesheet} }`}</style>
                  )}
                  {visualPlayback === "static" && (
                    <style>{`@scope (.slide-renderer[data-visual-playback="static"]) {
                      :scope, :scope *, :scope::before, :scope::after,
                      :scope *::before, :scope *::after {
                        animation-play-state: paused !important;
                      }
                    }`}</style>
                  )}
                  {layerRoots(slide).map((root) => {
                    const layer = layers.get(root.id);
                    if (!layer || layer.hidden) return null;
                    return (
                      <div
                        key={root.id}
                        data-layer-id={root.id}
                        data-layer-locked={layer.locked ? "true" : undefined}
                        style={{ position: "absolute", inset: 0 }}
                      >
                        {root.children.map((element) => (
                          <ElementView
                            key={element.id}
                            element={element}
                            staticVideo={staticVideo}
                            presentation={presentation}
                            editorPlayback={editorPlayback}
                            editingTextId={editingTextId}
                            inherited={
                              resolved?.sources.get(element.id) === "template"
                            }
                            composition={composition}
                            opacityPlan={opacityPlan}
                          />
                        ))}
                      </div>
                    );
                  })}
                  {editorOverflow &&
                    editingMedia?.element.content?.type === "image" && (
                      <div
                        data-media-edit-reveal={editingMedia.element.id}
                        style={{
                          position: "absolute",
                          left: 0,
                          top: 0,
                          width: editingMedia.element.frame.width,
                          height: editingMedia.element.frame.height,
                          transform: `matrix(${editingMedia.world.join(",")})`,
                          transformOrigin: "0 0",
                          opacity: 0.4,
                          pointerEvents: "none",
                          clipPath: `polygon(evenodd, -100000px -100000px, 100000px -100000px, 100000px 100000px, -100000px 100000px, -100000px -100000px, 0px 0px, 0px ${editingMedia.element.frame.height}px, ${editingMedia.element.frame.width}px ${editingMedia.element.frame.height}px, ${editingMedia.element.frame.width}px 0px, 0px 0px)`,
                        }}
                      >
                        <MediaView
                          element={editingMedia.element}
                          staticVideo={true}
                          presentation={false}
                          editorPlayback="inactive"
                        />
                      </div>
                    )}
                </div>
              </ImageDocumentContext.Provider>
            </VideoPreparationContext.Provider>
          </TextStylesContext.Provider>
        </SceneTextureSceneContext.Provider>
      </EffectResourcesContext.Provider>
    </EffectRenderContext.Provider>
  );
});
