const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EditorState, EditorSelection } = require("@codemirror/state");
const { markersFor } = require("../lib/markers");
const { visualSelection } = require("../lib/selection");

test("Visual 選択は混在した入れ子の全体・部分選択で方向と記号を保持する", () => {
  const { doc } = EditorState.create({ doc: "**a ~~bc~~ d**" });
  for (const [anchor, requested, expected] of [
    [2, 11, [0, 14]],
    [11, 2, [14, 0]],
    [6, 7, [4, 10]],
    [7, 6, [10, 4]],
    [6, 6, [6, 7]],
  ]) {
    const range =
      anchor <= requested
        ? EditorSelection.range(anchor, requested + 1)
        : EditorSelection.range(anchor + 1, requested);
    const result = visualSelection({
      doc,
      range,
      anchor,
      requested,
      target: requested,
      previousHead: anchor,
      markers: markersFor(doc),
    });
    assert.deepEqual([result.range.anchor, result.range.head], expected);
    assert.equal(result.head, requested);
  }
});

test("Visual 選択は記号を飛び越えた移動先の文字を両方向とも含める", () => {
  const { doc } = EditorState.create({ doc: "x **ab** y" });
  for (const [anchor, requested, previousHead, expected, head] of [
    [0, 2, 1, [0, 5], 4],
    [9, 7, 8, [10, 5], 5],
  ]) {
    const result = visualSelection({
      doc,
      range: EditorSelection.range(anchor, requested),
      anchor,
      requested,
      target: requested,
      previousHead,
      markers: markersFor(doc),
    });
    assert.deepEqual([result.range.anchor, result.range.head], expected);
    assert.equal(result.head, head);
  }
});
