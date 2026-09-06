import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("../", import.meta.url).pathname },
  interopDefault: true,
});
const { hasDraggedFiles } = await jiti.import("./useDragDrop.ts");

test("recognizes arbitrary dragged files", () => {
  assert.equal(hasDraggedFiles({ items: [{ kind: "file" }], types: [] }), true);
  assert.equal(hasDraggedFiles({ items: [], types: ["Files"] }), true);
  assert.equal(hasDraggedFiles({ items: [{ kind: "string" }], types: ["text/plain"] }), false);
});
