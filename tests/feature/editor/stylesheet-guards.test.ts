import { expect, it } from "vitest";
import { DocumentAuthority } from "../../../src/core/documentAuthority";
import { newPresentationDocument } from "../../../src/core/document";

function authority() {
  const document = newPresentationDocument("Styles");
  const owner = new DocumentAuthority(document);
  async function set(
    actor: string,
    changes: { name?: string; stylesheet?: string },
    baseRevision = owner.revision,
  ) {
    const acquired = owner.acquire(actor, [{ kind: "deck" }]);
    if (acquired.denied) throw new Error("Lease denied");
    const leaseTokens = acquired.grants.map(({ token }) => token);
    try {
      return await owner.commit(actor, {
        transactionId: crypto.randomUUID(),
        documentId: document.documentId,
        epoch: owner.epoch,
        baseRevision,
        leaseTokens,
        operations: [{ type: "deck.properties.set", changes }],
      });
    } finally {
      owner.release(actor, leaseTokens);
    }
  }
  return { owner, set };
}

it("rejects stale stylesheet writes while unrelated deck properties merge", async () => {
  const { owner, set } = authority();
  await set("A", { stylesheet: "red" });
  await expect(set("B", { stylesheet: "blue" }, 0)).rejects.toThrow();
  await set("B", { name: "Renamed" }, 0);
  expect(owner.document.deck).toMatchObject({
    name: "Renamed",
    stylesheet: "red",
  });
});

it("actor undo cannot replace another actor's later stylesheet", async () => {
  const { owner, set } = authority();
  await set("A", { stylesheet: "red" });
  await set("B", { stylesheet: "blue" });
  await expect(owner.undo("A")).rejects.toThrow("no longer safe");
  expect(owner.document.deck.stylesheet).toBe("blue");
});

it("actor redo cannot replace another actor's stylesheet after undo", async () => {
  const { owner, set } = authority();
  await set("A", { stylesheet: "red" });
  await owner.undo("A");
  await set("B", { stylesheet: "blue" });
  await expect(owner.redo("A")).rejects.toThrow("no longer safe");
  expect(owner.document.deck.stylesheet).toBe("blue");
});
