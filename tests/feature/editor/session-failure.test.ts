import { expect, it } from "vitest";
import { setSlideNotes } from "../../../src/core/editorCommands";
import { editing } from "../../helpers/document";
import { EditorSession } from "../../../src/core/editorSession";

it("retry after an accepted edit refresh failure does not resubmit the edit", async () => {
  const { session, runtime } = await editing();
  const history = runtime.historyState.bind(runtime);
  runtime.historyState = async () => {
    throw new Error("History unavailable");
  };
  session.apply(setSlideNotes(session.snapshot!, "Accepted"));
  await expect(session.flush()).rejects.toThrow("History unavailable");
  expect(runtime.authority.revision).toBe(1);
  runtime.historyState = history;
  await session.retryFailedIntents();
  expect(runtime.authority.revision).toBe(1);
  runtime.historyState = async () => {
    throw new Error("History unavailable");
  };
  session.undo();
  await expect(session.flush()).rejects.toThrow("History unavailable");
  expect(runtime.authority.revision).toBe(2);
  runtime.historyState = history;
  await session.retryFailedIntents();
  expect(runtime.authority.revision).toBe(2);
});

it("flush retains failed intent across later edits until explicit retry", async () => {
  let fail = true;
  const error = new Error("Durability failed");
  const { session, runtime, slideId } = await editing(async () => {
    if (fail) throw error;
  });
  session.apply(setSlideNotes(session.snapshot!, "First"));
  await expect(session.flush()).rejects.toBe(error);
  expect(session.isDirty).toBe(true);
  expect(runtime.authority.revision).toBe(0);
  fail = false;
  session.apply(setSlideNotes(session.snapshot!, "Second"));
  await expect(session.flush()).rejects.toBe(error);
  expect(runtime.authority.revision).toBe(0);
  await session.retryFailedIntents();
  expect(runtime.authority.revision).toBe(2);
  expect(runtime.authority.document.slides[slideId].notes).toBe("Second");
  await expect(session.flush()).resolves.toBeUndefined();
});

it("initial projection failure is observable and retry loads the same session", async () => {
  const { document, runtime } = await editing();
  const session = new EditorSession(document.documentId, runtime);
  const project = runtime.projection.bind(runtime);
  runtime.projection = async () => {
    throw new Error("Projection unavailable");
  };
  try {
    await expect(session.loadProjection()).rejects.toThrow(
      "Projection unavailable",
    );
    expect(session.replica).toBeNull();
    expect(session.lastError).toBeInstanceOf(Error);
    runtime.projection = project;
    await session.loadProjection();
    expect(session.snapshot).not.toBeNull();
    expect(session.lastError).toBeNull();
  } finally {
    session.dispose();
  }
});

it("disposed sessions do not publish late projection results", async () => {
  const { document, runtime } = await editing();
  const projection = await runtime.projection(document.documentId);
  let finish!: (value: typeof projection) => void;
  runtime.projection = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const session = new EditorSession(document.documentId, runtime);
  const loading = session.loadProjection();
  session.dispose();
  finish(projection);
  await loading;
  expect(session.replica).toBeNull();
});

it("explicit discard unblocks the queue without accepting failed edits", async () => {
  let fail = true;
  const { session, runtime, slideId } = await editing(async () => {
    if (fail) throw new Error("No disk space");
  });
  session.apply(setSlideNotes(session.snapshot!, "Failed"));
  await expect(session.flush()).rejects.toThrow("No disk space");
  await session.discardFailedIntents();
  await session.flush();
  expect(runtime.authority.revision).toBe(0);
  expect(session.snapshot!.slide.notes).toBe("");
  fail = false;
  session.apply(setSlideNotes(session.snapshot!, "New"));
  await session.flush();
  expect(runtime.authority.document.slides[slideId].notes).toBe("New");
});
