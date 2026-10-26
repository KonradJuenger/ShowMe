import {
  motionPlaybackSchema,
  type MotionStageTiming,
} from "../src/core/motionPlayback";
import { BrowserWindow, screen } from "electron";
import { z } from "zod";
import type { PresenterState } from "../src/platform/api";
import { idSchema } from "../src/core/ids";
import {
  applyPresentationCommand,
  reconcileSession,
  startSession,
  type PresentationCommand,
} from "../src/core/presentationSession";
import type { Deck } from "../src/core/document";
import { loadWindow, secureWindow, windowOptions } from "./windowing";
import {
  resolvePresentationDisplays,
  type PresentationDisplayAssignment,
} from "../src/core/presentationDisplays";

const stateSchema = z.object({
  motion: motionPlaybackSchema.optional(),
  presentationReady: z.boolean().optional(),
  motionSlides: z
    .record(
      z.string(),
      z.array(
        z.object({ id: idSchema, duration: z.number().nonnegative() }).strict(),
      ),
    )
    .optional(),
  deckId: idSchema,
  slideIds: z.array(idSchema).max(10000),
  index: z.number().int().nonnegative().nullable(),
  previousSlideId: idSchema.optional(),
  previousSlideIndex: z.number().int().nonnegative().optional(),
  black: z.boolean().optional(),
  restartToken: z.number().int().nonnegative().optional(),
  startedAt: z.number().finite().optional(),
  elapsedStartedAt: z.number().finite().optional(),
  slideStartedAt: z.number().finite().optional(),
  stepStartedAt: z.number().finite().optional(),
  motionStageStartedOffsets: z
    .array(z.number().finite().nonnegative())
    .max(10000)
    .optional(),
  pausedAt: z.number().finite().optional(),
  pausedDuration: z.number().nonnegative().optional(),
  resumeMotion: z.boolean().optional(),
  contentRevision: z.number().int().nonnegative().optional(),
});

const presentationCommandSchema = z.union([
  z.object({
    type: z.enum([
      "next",
      "previous",
      "first",
      "last",
      "toggle-black",
      "toggle-pause",
      "restart-media",
    ]),
  }),
  z.object({ type: z.literal("jump"), index: z.number().int() }),
  z.object({ type: z.literal("black"), value: z.boolean() }),
  z.object({
    type: z.literal("audience-ready"),
    sessionStartedAt: z.number().finite(),
    motionStartedAt: z.number().finite(),
    slideId: idSchema,
  }),
]);

function normalizePresentationState(input: PresenterState): PresenterState {
  const parsed = stateSchema.parse(input);
  return {
    ...parsed,
    index: parsed.slideIds.length
      ? Math.max(0, Math.min(parsed.slideIds.length - 1, parsed.index ?? 0))
      : null,
    black: parsed.black ?? false,
    restartToken: parsed.restartToken ?? 0,
  };
}

export class PresentationRuntime {
  private loadedDeck: Deck | null = null;
  private displayAssignment: PresentationDisplayAssignment | null = null;
  private consoleBounds: string | null = null;
  private audienceBounds: string | null = null;
  private editor: BrowserWindow | null = null;
  private audience: BrowserWindow | null = null;
  private consoleWindow: BrowserWindow | null = null;
  private current: PresenterState | null = null;
  private openingAudience = false;
  private whenAudienceShown: Promise<void> | null = null;
  private audienceShown: (() => void) | null = null;

  constructor(
    private readonly loadDeck: (documentId: string) => Promise<Deck>,
    private readonly loadMotion?: (
      documentId: string,
      deck: Deck,
      slideIds?: string[],
    ) => Promise<Record<string, MotionStageTiming[]>>,
    private readonly onDisplaysChanged?: () => void,
  ) {
    screen.on("display-removed", (_event, removed) => {
      if (
        this.current &&
        (removed.id === this.current.audienceDisplayId ||
          removed.id === this.current.presenterDisplayId)
      )
        this.end();
      if (this.displayAssignment)
        this.displayAssignment = resolvePresentationDisplays(
          screen.getAllDisplays(),
          screen.getPrimaryDisplay().id,
          this.displayAssignment,
        );
      this.publishDisplays();
    });
    screen.on("display-metrics-changed", () => {
      if (this.current?.audienceDisplayId !== undefined) {
        this.positionAudience(this.current.audienceDisplayId);
        this.positionConsole(this.current.presenterDisplayId!);
        this.publish();
      }
      this.publishDisplays();
    });
    screen.on("display-added", () => this.publishDisplays());
  }

  setEditor(window: BrowserWindow | null) {
    this.editor = window;
  }

  get audienceWindow() {
    return this.audience;
  }

  get presenterConsoleWindow() {
    return this.consoleWindow;
  }

  get state() {
    return this.current;
  }

  async outputShown() {
    await this.whenAudienceShown;
  }

  get assignment() {
    if (
      this.current?.presenterDisplayId !== undefined &&
      this.current.audienceDisplayId !== undefined
    )
      return {
        presenterDisplayId: this.current.presenterDisplayId,
        audienceDisplayId: this.current.audienceDisplayId,
      };
    return resolvePresentationDisplays(
      screen.getAllDisplays(),
      screen.getPrimaryDisplay().id,
      this.displayAssignment,
    );
  }

  private publishDisplays() {
    this.onDisplaysChanged?.();
    for (const window of [this.editor, this.consoleWindow])
      if (window && !window.isDestroyed())
        window.webContents.send("presentation-displays", this.displays());
  }

  private publish() {
    for (const window of [this.editor, this.audience, this.consoleWindow])
      if (window && !window.isDestroyed())
        window.webContents.send("presentation", this.current);
  }

  end() {
    const audience = this.audience;
    const consoleWindow = this.consoleWindow;
    this.audience = null;
    this.audienceBounds = null;
    this.consoleWindow = null;
    this.consoleBounds = null;
    this.current = null;
    this.openingAudience = false;
    this.audienceShown?.();
    this.audienceShown = null;
    this.whenAudienceShown = null;
    if (audience && !audience.isDestroyed()) audience.destroy();
    if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.destroy();
    this.publish();
    this.publishDisplays();
    if (this.editor && !this.editor.isDestroyed()) this.editor.focus();
  }

  private positionAudience(displayId: number) {
    const display = screen
      .getAllDisplays()
      .find((item) => item.id === displayId);
    if (!display || !this.audience || !this.current) return;
    const bounds = JSON.stringify({ id: display.id, ...display.bounds });
    if (this.audienceBounds === bounds) return;
    this.audienceBounds = bounds;
    this.audience.setFullScreen(false);
    this.audience.setBounds(display.bounds);
    this.audience.setFullScreen(true);
    this.current = {
      ...this.current,
      audienceDisplayId: display.id,
      displayWarning: undefined,
    };
  }

  private positionConsole(displayId: number) {
    const display = screen
      .getAllDisplays()
      .find((item) => item.id === displayId);
    if (!display || !this.consoleWindow || this.consoleWindow.isDestroyed())
      return;
    const bounds = JSON.stringify({ id: display.id, ...display.workArea });
    if (bounds === this.consoleBounds) return;
    this.consoleBounds = bounds;
    const maximized = this.consoleWindow.isMaximized();
    if (maximized) this.consoleWindow.unmaximize();
    this.consoleWindow.setBounds({
      x: display.workArea.x,
      y: display.workArea.y,
      width: Math.min(1440, display.workArea.width),
      height: Math.min(920, display.workArea.height),
    });
    if (maximized) this.consoleWindow.maximize();
  }

  async openPresenterConsole() {
    if (!this.current) return;
    if (this.consoleWindow && !this.consoleWindow.isDestroyed()) {
      this.consoleWindow.show();
      this.consoleWindow.focus();
      return;
    }
    const display =
      screen
        .getAllDisplays()
        .find((item) => item.id === this.current?.presenterDisplayId) ??
      screen.getPrimaryDisplay();
    const work = display.workArea;
    const consoleWindow = new BrowserWindow({
      ...windowOptions(),
      x: work.x,
      y: work.y,
      width: Math.min(1440, work.width),
      height: Math.min(920, work.height),
      show: false,
      title: "Presenter Console",
      autoHideMenuBar: true,
      movable: false,
    });
    this.consoleWindow = consoleWindow;
    consoleWindow.setMenu(null);
    secureWindow(consoleWindow);
    consoleWindow.on("closed", () => {
      if (this.consoleWindow === consoleWindow) this.end();
    });
    await loadWindow(consoleWindow, "console");
    if (this.current) this.positionConsole(this.current.presenterDisplayId!);
    if (!consoleWindow.isDestroyed()) consoleWindow.show();
  }

  async command(command: PresentationCommand) {
    if (!this.current) return;
    const parsed = presentationCommandSchema.parse(command);
    if (parsed.type === "audience-ready" && this.openingAudience) {
      await this.whenAudienceShown;
      if (!this.current) return;
    }
    if (
      parsed.type === "audience-ready" &&
      this.current.awaitingAudience &&
      this.audience &&
      !this.audience.isDestroyed()
    ) {
      await this.audience.webContents.capturePage().catch(() => {});
      if (!this.current) return;
    }
    this.current = applyPresentationCommand(this.current, parsed);
    this.publish();
  }

  async refresh(
    documentId: string,
    impact?: { presentation: string; slides: string[] | null },
  ) {
    if (
      !this.current ||
      this.current.deckId !== documentId ||
      impact?.presentation === "none"
    )
      return;
    if (impact?.presentation === "content") {
      this.current = {
        ...this.current,
        contentRevision: (this.current.contentRevision ?? 0) + 1,
      };
      this.publish();
      return;
    }
    const scoped =
      impact?.presentation === "motion" && impact.slides && this.loadedDeck;
    const deck = scoped ? this.loadedDeck! : await this.loadDeck(documentId);
    this.loadedDeck = deck;
    if (!this.current || this.current.deckId !== documentId) return;
    const updatedMotion = await this.loadMotion?.(
      documentId,
      deck,
      scoped ? impact!.slides! : undefined,
    );
    const motionSlides = scoped
      ? { ...this.current.motionSlides, ...updatedMotion }
      : updatedMotion;
    if (!this.current || this.current.deckId !== documentId) return;
    this.current = reconcileSession(
      {
        ...this.current,
        motionSlides,
        contentRevision: (this.current.contentRevision ?? 0) + 1,
      },
      deck,
    );
    this.publish();
  }

  displays() {
    const assignment = this.assignment;
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      label:
        display.label ||
        `Display ${index + 1} (${display.size.width} × ${display.size.height})`,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      primary: display.id === primaryId,
      presenter: display.id === assignment.presenterDisplayId,
      audience: display.id === assignment.audienceDisplayId,
    }));
  }

  async present(input: PresenterState) {
    if (!this.editor || this.editor.isDestroyed())
      throw new Error("Editor window is unavailable");
    if (this.openingAudience)
      throw new Error("Presentation is already starting");
    const parsed = normalizePresentationState(input);
    this.openingAudience = true;
    const deck = await this.loadDeck(parsed.deckId).catch((error) => {
      this.openingAudience = false;
      throw error;
    });
    this.loadedDeck = deck;
    const displays = screen.getAllDisplays();
    const assignment = this.assignment;
    const audienceDisplay = displays.find(
      (item) => item.id === assignment.audienceDisplayId,
    )!;
    const consoleDisplay = displays.find(
      (item) => item.id === assignment.presenterDisplayId,
    )!;
    const motionSlides = await this.loadMotion?.(parsed.deckId, deck).catch(
      (error) => {
        this.openingAudience = false;
        throw error;
      },
    );
    this.current = {
      ...startSession(parsed, deck, Date.now(), motionSlides, true),
      presenterDisplayId: consoleDisplay.id,
      audienceDisplayId: audienceDisplay.id,
    };
    if (this.audience && !this.audience.isDestroyed()) {
      this.positionAudience(audienceDisplay.id);
      await this.openPresenterConsole();
      this.openingAudience = false;
      this.publish();
      return;
    }
    this.openingAudience = true;
    this.whenAudienceShown = new Promise((resolve) => {
      this.audienceShown = resolve;
    });
    const audience = new BrowserWindow({
      ...windowOptions(),
      webPreferences: {
        ...windowOptions().webPreferences,
        backgroundThrottling: false,
      },
      ...audienceDisplay.bounds,
      show: false,
      title: "Audience Output",
      autoHideMenuBar: true,
    });
    this.audience = audience;
    audience.setMenu(null);
    secureWindow(audience);
    audience.on("closed", () => {
      if (this.audience === audience) this.end();
    });
    try {
      await loadWindow(audience, "audience");
      await this.openPresenterConsole();
      if (audience.isDestroyed()) return;
      audience.show();
      await new Promise<void>((resolve) => {
        const done = () => {
          audience.removeListener("enter-full-screen", done);
          audience.removeListener("closed", done);
          resolve();
        };
        audience.once("enter-full-screen", done);
        audience.once("closed", done);
        audience.setFullScreen(true);
      });
      if (audience.isDestroyed()) return;
      this.openingAudience = false;
      this.audienceShown?.();
      this.audienceShown = null;
      this.whenAudienceShown = null;
      if (displays.length > 1) this.consoleWindow?.focus();
      this.publish();
    } catch (error) {
      this.end();
      throw error;
    }
  }

  async update(input: PresenterState) {
    if (!this.current || input.deckId !== this.current.deckId) return;
    const deck = await this.loadDeck(this.current.deckId);
    this.loadedDeck = deck;
    const motionSlides = await this.loadMotion?.(input.deckId, deck);
    if (this.current && this.current.deckId === input.deckId) {
      this.current = reconcileSession({ ...this.current, motionSlides }, deck);
      this.publish();
    }
  }

  navigate(index: number) {
    return this.command({ type: "jump", index });
  }

  setBlack(value: boolean) {
    return this.command({ type: "black", value });
  }

  restartMedia() {
    return this.command({ type: "restart-media" });
  }

  fullscreen() {
    if (this.audience)
      this.audience.setFullScreen(!this.audience.isFullScreen());
  }

  setPresentationDisplays(input: PresentationDisplayAssignment | null) {
    if (this.current || this.openingAudience)
      throw new Error("End the presentation before changing screen setup");
    const requested =
      input === null
        ? null
        : z
            .object({
              presenterDisplayId: z.number().int(),
              audienceDisplayId: z.number().int(),
            })
            .strict()
            .parse(input);
    const assignment = resolvePresentationDisplays(
      screen.getAllDisplays(),
      screen.getPrimaryDisplay().id,
      requested,
    );
    if (
      requested &&
      (assignment.presenterDisplayId !== requested.presenterDisplayId ||
        assignment.audienceDisplayId !== requested.audienceDisplayId)
    )
      throw new Error(
        "Choose different attached displays for Presenter and Audience",
      );
    this.displayAssignment = requested;
    this.publishDisplays();
  }
}
