const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { EditorState } = require("@codemirror/state");
const { Direction } = require("@codemirror/view");
const { createVisualCursor } = require("../lib/visual-cursor");

test("専用カーソルは描画対象がなくても DOM の監視を再開する", async (t) => {
  const dom = new JSDOM("<!doctype html><body></body>");
  t.after(() => dom.window.close());
  global.document = dom.window.document;
  global.MutationObserver = dom.window.MutationObserver;
  const scrollDOM = document.createElement("div");
  document.body.appendChild(scrollDOM);
  const nativeLayer = document.createElement("div");
  nativeLayer.className = "cm-vimCursorLayer";
  scrollDOM.appendChild(nativeLayer);
  const native = document.createElement("span");
  native.className = "cm-cursor-primary";
  native.style.visibility = "visible";
  let head = null;
  let measurement;
  let scheduled = 0;
  let fallbackCalls = 0;
  const editor = {
    state: EditorState.create({
      doc: "x **ab** y",
      selection: { anchor: 4, head: 8 },
    }),
    cm: { state: { vim: { visualMode: true } } },
    scrollDOM,
    textDirection: Direction.LTR,
    scaleX: 1,
    scaleY: 1,
    coordsForChar: () => null,
    coordsAtPos() {
      fallbackCalls++;
      return { left: 20, top: 30 };
    },
    requestMeasure(request) {
      measurement = request;
      scheduled++;
    },
  };
  const cursor = createVisualCursor(editor, () => head);
  t.after(() => cursor.destroy());
  cursor.schedule();
  measurement.write(measurement.read());
  // 計測対象がなくても、その後の標準カーソル追加を検知する。
  nativeLayer.appendChild(native);
  await Promise.resolve();
  assert.equal(scheduled, 2);
  head = 5;
  measurement.write(measurement.read());
  assert.equal(fallbackCalls, 1);
  assert.equal(native.style.visibility, "hidden");
  assert.equal(
    scrollDOM.querySelector(".hide-markup-cursor-layer .cm-cursor-primary")
      .textContent,
    "b"
  );
  // 標準カーソルがない間の描画後も、再追加を検知する。
  native.remove();
  await Promise.resolve();
  measurement.write(measurement.read());
  assert.equal(native.style.visibility, "visible");
  const before = scheduled;
  nativeLayer.appendChild(native);
  await Promise.resolve();
  assert.equal(scheduled, before + 1);
  measurement.write(measurement.read());
  assert.equal(native.style.visibility, "hidden");
  head = null;
  measurement.write(measurement.read());
  assert.equal(native.style.visibility, "visible");
  assert.equal(
    scrollDOM.querySelector(".hide-markup-cursor-layer").childElementCount,
    0
  );
});
