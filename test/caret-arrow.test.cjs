const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { EditorState } = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");
const { createExtension } = require("../lib/extension");

test("記号境界の補正後も同じ矢印入力で本文へ進み、修飾キー付きでは進めない", (t) => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  for (const name of [
    "window",
    "Window",
    "document",
    "MutationObserver",
    "HTMLElement",
    "Node",
  ]) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  for (const [modifiers, expected, prevented] of [
    [{}, 5, true],
    [{ shiftKey: true }, 2, false],
    [{ ctrlKey: true }, 2, false],
  ]) {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "x **ab** y",
        selection: { anchor: 4 },
        extensions: createExtension(),
      }),
    });
    t.after(() => view.destroy());
    const event = new dom.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    view.contentDOM.dispatchEvent(event);
    assert.equal(view.state.selection.main.head, expected);
    assert.equal(event.defaultPrevented, prevented);
  }
});
