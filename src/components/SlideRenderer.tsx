import { acquireVideoPlayer, videoPlayerKey } from "./preparedVideoPool";
import { resolveTextTypography } from "../core/textTypography";
import type { EffectClockOrigins } from "../core/effectClocks";
import { resolveVisualSlide } from "../core/templates";
import { usePreparedImage } from "./usePreparedImage";
import {
  planPresentationImages,
  type ImageRequestProfile,
  type ImageRequirement,
} from "../core/presentationImages";
import type { MotionPreviewState } from "../core/motionPlayback";
import { useMotionRuntime } from "./useMotionRuntime";
import { EffectSurface } from "./EffectSurface";
import { effectPlacement, type EffectResources } from "../core/effects";
import {
  memo,
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
import { useDisplayDensity } from "./useDisplayDensity";
import { EffectRenderContext } from "./EffectRenderContext";
import {
  liveRenderProfile,
  renderDensity,
  shaderScaleEnvelopes,
  type RenderScale,
  type SlideRenderProfile,
} from "../core/renderProfile";

const RasterSceneContext = createContext<{
  current: { slide: Slide; deck: Deck };
} | null>(null);
const VideoPreparationContext = createContext(false);
const TextStylesContext = createContext<Deck | undefined>(undefined);
const EffectResourcesContext = createContext<EffectResources>({});
const emptyEffectResources: EffectResources = {};

const ImageDocumentContext = createContext<{
  documentId: string;
  slideId: string;
  profile?: ImageRequestProfile;
  deferUpdates: boolean;
  requirements?: Map<string, ImageRequirement>;
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
    const player = acquireVideoPlayer(playerKey, content.assetId);
    video.current = player.node;
    videoHost.current.append(player.node);
    return () => { video.current = null; player.release(); };
  }, [playerKey, content.assetId, loadVideo]);
  const editorInactive = editorPlayback === "inactive";
  const posterKey = `${content.assetId}:${content.startTime}`;
  const [poster, setPoster] = useState<{
    key: string;
    url: string | null;
  } | null>(null);
  const [presented, setPresented] = useState(false);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    // Reuse cached posters; playback and warmup capture missing frames below.
    let live = true;
    void videoPoster(content.assetId, content.startTime, !loadVideo).then(
      (url) => {
        if (live) setPoster({ key: posterKey, url });
      },
    );
    return () => {
      live = false;
    };
  }, [content.assetId, content.startTime, posterKey, loadVideo]);

  // Keep the prepared element and source when the upcoming slide becomes active.
  useEffect(() => {
    const node = video.current;
    if (!node || url === undefined) return;
    setReady(false);
    setPresented(false);
    setIsPlaying(false);
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
      metadata(); decoded();
      paintFrame = requestAnimationFrame(() => { paintFrame = requestAnimationFrame(() => { if (live && atStart()) setPresented(true); }); });
    } else { node.src = url; node.load(); }
    return () => {
      live = false;
      if (videoFrame) node.cancelVideoFrameCallback(videoFrame);
      cancelAnimationFrame(paintFrame);
      node.removeEventListener("loadedmetadata", metadata);
      node.removeEventListener("loadeddata", decoded);
      node.removeEventListener("seeked", decoded);
      node.pause();
    };
  }, [url, loadVideo, onSize]);

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
      void node.play().catch(() => {});
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
    node.muted = content.mute; node.volume = content.volume;
    node.controls = editorPreview || (!presentation && editorPlayback === undefined && !content.autoplay);
    Object.assign(node.style, { display: "block", width: "100%", height: "100%", objectFit: "fill", visibility: activePlayback ? "visible" : "hidden" });
    const play = () => setIsPlaying(true), pause = () => setIsPlaying(false);
    const update = () => enforceEnd(node);
    const ended = () => { if (content.loop) { node.currentTime = videoBounds(content, node.duration).start; void node.play().catch(() => {}); } };
    node.addEventListener("play", play); node.addEventListener("pause", pause); node.addEventListener("timeupdate", update); node.addEventListener("ended", ended); node.addEventListener("error", onError);
    return () => { node.removeEventListener("play", play); node.removeEventListener("pause", pause); node.removeEventListener("timeupdate", update); node.removeEventListener("ended", ended); node.removeEventListener("error", onError); };
  }, [content, activePlayback, editorPreview, presentation, editorPlayback, enforceEnd, onError, loadVideo]);

  const posterUrl =
    (poster?.key === posterKey ? poster.url : null) ||
    (content.startTime === 0 ? previewUrl : null);
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
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
      {loadVideo && <div ref={videoHost} style={{ width: "100%", height: "100%" }} />}
      {presentation && !staticVideo && !content.autoplay && ready && (
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
      style={{ display: "block", borderRadius: "inherit" }}
    >
      <defs>
        <pattern
          id="missing-media-diagonal-lines"
          width="16"
          height="16"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="16"
            stroke="#b6b6b2"
            strokeWidth="3"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="#d8d8d4" />
      <rect
        width="100%"
        height="100%"
        fill="url(#missing-media-diagonal-lines)"
      />
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
    imageDocument?.requirements?.get(element.id),
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
  if (
    !checking &&
    (failed || (url === null && (content.type !== "video" || !previewUrl)))
  )
    return <MissingMediaPlaceholder />;
  if (!frame)
    return (
      <div data-media-loading={content.type === "image" ? "true" : undefined} />
    );

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
      data-media-loading={
        content.type === "image" &&
        (url === undefined || checking || decodedUrl !== url)
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
}: {
  element: Element;
  staticVideo: boolean;
  presentation: boolean;
  editorPlayback?: EditorPlayback;
  editingTextId?: string | null;
  inherited?: boolean;
}) {
  const { frame, appearance } = element;
  const resources = useContext(EffectResourcesContext);
  const effectRender = useContext(EffectRenderContext);
  const scene = useContext(RasterSceneContext);
  const effects = (element.effects ?? []).filter(
    (e) => e.enabled && resources[e.resourceId],
  );
  const rasterContent = useMemo(
    () => ({
      element,
      resources: scene?.current.slide.effectResources ?? emptyEffectResources,
      scene: scene ? () => scene.current : undefined,
    }),
    [element, scene],
  );
  const contentShaders = effects.filter(
    (e) =>
      resources[e.resourceId].kind === "fragment-glsl" &&
      resources[e.resourceId].input === "content" &&
      element.id !== editingTextId,
  );
  const surface = (
    instance: (typeof effects)[number],
    children?: ReactNode,
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
      rasterContent={
        ["content", "backdrop"].includes(
          resources[instance.resourceId].input ?? "none",
        )
          ? rasterContent
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
  let content = (
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
      {element.children.map((child) => (
        <ElementView
          key={child.id}
          element={child}
          staticVideo={staticVideo}
          presentation={presentation}
          editorPlayback={editorPlayback}
          editingTextId={editingTextId}
        />
      ))}
    </>
  );
  // Earlier stages form the input of later stages, as in the shader pipeline.
  for (const effect of effects.filter(
    (e) =>
      effectPlacement(resources[e.resourceId], e) === "content" &&
      resources[e.resourceId].input !== "content" &&
      element.id !== editingTextId,
  ))
    content = surface(effect, content);
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

  let visual = (
    <>
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          borderRadius: shape,
          overflow: element.clipChildren ? "hidden" : "visible",
        }}
      >
        {appearance.fill && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: appearance.fill,
              borderRadius: shape,
            }}
          />
        )}
        {effects
          .filter(
            (e) => effectPlacement(resources[e.resourceId], e) === "background",
          )
          .map((e) => surface(e))}
        {content}
        {effects
          .filter(
            (e) => effectPlacement(resources[e.resourceId], e) === "overlay",
          )
          .map((e) => surface(e))}
      </div>
      {appearance.strokeWidth > 0 && (
        <div data-element-stroke="true" aria-hidden="true" style={outline} />
      )}
    </>
  );
  for (const shader of contentShaders) visual = surface(shader, visual);

  return (
    <div
      data-element-id={element.id}
      data-template-content={inherited ? "true" : undefined}
      data-showme-id={`showme-${element.id}`}
      data-showme-part="self"
      className={element.cssClasses?.join(" ")}
      style={{
        position: "absolute",
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        transform: frameCssTransform(frame),
        transformOrigin: frameCssOrigin(frame),
        opacity: appearance.opacity,
      }}
    >
      {visual}
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
  canvasImageSampling = false,
  deferImageUpdates = false,
  prepareVideo = false,
  effectClock,
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
  imageProfile?: ImageRequestProfile;
  renderScale?: RenderScale;
  renderProfile?: SlideRenderProfile;
  canvasImageSampling?: boolean;
  deferImageUpdates?: boolean;
  prepareVideo?: boolean;
  effectClock?: EffectClockOrigins;
}) {
  const resolved = useMemo(
    () => (templates ? resolveVisualSlide(deck, localSlide, templates) : null),
    [deck, localSlide, templates],
  );
  const slide = resolved?.slide ?? localSlide;
  const editingMedia = editingMediaId
    ? locateElement(slide, editingMediaId)
    : null;
  const root = useRef<HTMLDivElement>(null);
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
    }),
    [width, height, output, deferImageUpdates, playing, envelopes],
  );
  useMotionRuntime(
    root,
    slide,
    motionState,
    !!effectClock || !staticVideo,
    effectClock,
  );
  const rasterScene = useRef({ slide, deck });
  rasterScene.current = { slide, deck };
  const layers = new Map(deck.layers.map((layer) => [layer.id, layer]));
  const imageContext = useMemo(() => {
    if (!preparedImages || !output) return null;
    const profile: ImageRequestProfile = imageProfile ?? {
      width: output.width,
      height: output.height,
      ...(canvasImageSampling ? { sampling: "canvas" as const } : {}),
    };
    const requirements =
      canvasImageSampling && profile
        ? new Map(
            planPresentationImages(deck, [slide], profile, true).flatMap(
              (requirement) =>
                requirement.instances.map(
                  ({ elementId }) => [elementId, requirement] as const,
                ),
            ),
          )
        : undefined;
    return {
      documentId: deck.id,
      slideId: slide.id,
      deferUpdates: deferImageUpdates,
      profile,
      requirements,
    };
  }, [
    preparedImages,
    imageProfile,
    deck,
    slide,
    output,
    canvasImageSampling,
    deferImageUpdates,
  ]);
  return (
    <EffectRenderContext.Provider value={effectRender}>
      <EffectResourcesContext.Provider
        value={slide.effectResources ?? emptyEffectResources}
      >
        <RasterSceneContext.Provider value={rasterScene}>
          <TextStylesContext.Provider value={deck}>
            <VideoPreparationContext.Provider value={prepareVideo}>
              <ImageDocumentContext.Provider value={imageContext}>
                <div
                  ref={root}
                  className="slide-renderer"
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
        </RasterSceneContext.Provider>
      </EffectResourcesContext.Provider>
    </EffectRenderContext.Provider>
  );
});

