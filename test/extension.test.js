import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markersFor } from "../lib/markers.js";
import { createExtension } from "../lib/extension.js";

function state(doc, head, block = false) {
  return EditorState.create({
    doc,
    selection: { anchor: head },
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      createExtension(() => block),
    ],
  });
}

test("構文に成立した ** のみを検出する", () => {
  for (const text of [
    "`**a**`",
    "```\n**a**\n```",
    "    **a**",
    "\\**a**",
    "**a",
    "__a__",
  ]) {
    assert.deepEqual(markersFor(state(text, 0).doc), [], text);
  }
  assert.deepEqual(
    markersFor(state("**a** **b**", 0).doc).map((m) => [m.from, m.to]),
    [
      [0, 2],
      [3, 5],
      [6, 8],
      [9, 11],
    ]
  );
  assert.equal(markersFor(state("***a***", 0).doc).length, 2);
});

test("通常カーソルが開始・終了記号を通過する", () => {
  for (const [from, target, expected] of [
    [0, 1, 0],
    [2, 1, 0],
    [3, 4, 5],
    [5, 4, 5],
    [6, 5, 5],
  ]) {
    const s = state("**a** x", from);
    assert.equal(
      s.update({ selection: { anchor: target } }).state.selection.main.head,
      expected
    );
  }
});

test("行頭と上下移動で前の行に押し戻されない", () => {
  const s = state("**ab**\n**cd**", 9);
  assert.equal(s.update({ selection: { anchor: 0 } }).state.selection.main.head, 0);
  assert.equal(s.update({ selection: { anchor: 7 } }).state.selection.main.head, 7);
  assert.equal(
    state("**ab**", 3, true).update({ selection: { anchor: 0 } }).state.selection
      .main.head,
    2
  );
});

test("Vim ブロックカーソルが行末記号と隣接記号に停止しない", () => {
  assert.equal(
    state("**ab**", 2, true).update({ selection: { anchor: 5 } }).state.selection
      .main.head,
    3
  );
  assert.equal(
    state("**a** **b**", 2, true).update({ selection: { anchor: 3 } }).state
      .selection.main.head,
    5
  );
});

test("範囲選択の方向と複数カーソルを保持する", () => {
  const s = state("x **ab** y", 0);
  const tr = s.update({
    selection: EditorSelection.create(
      [EditorSelection.range(1, 3), EditorSelection.range(9, 7)],
      1
    ),
  });
  assert.equal(tr.state.selection.mainIndex, 1);
  assert.deepEqual(
    tr.state.selection.ranges.map((r) => [r.anchor, r.head]),
    [
      [1, 4],
      [9, 6],
    ]
  );
});

test("編集後の構文に合わせて位置補正する", () => {
  const s = state("**a*", 4);
  const tr = s.update({
    changes: { from: 4, insert: "*" },
    selection: { anchor: 4 },
  });
  assert.equal(markersFor(tr.state.doc).length, 2);
  assert.equal(tr.state.doc.toString(), "**a**");
  assert.equal(tr.state.selection.main.head, 5);
});

test("成立した二重チルダの削除記法のみを検出する", () => {
  for (const text of [
    "~a~",
    "`~~a~~`",
    "```\n~~a~~\n```",
    "    ~~a~~",
    "\\~~a~~",
    "~~a",
    "~~ a ~~",
  ]) {
    assert.deepEqual(markersFor(state(text, 0).doc), [], text);
  }
  assert.deepEqual(
    markersFor(state("~~a~~ ~~b~~", 0).doc).map((m) => [m.from, m.to]),
    [
      [0, 2],
      [3, 5],
      [6, 8],
      [9, 11],
    ]
  );
  for (const text of ["**a ~~b~~ c**", "~~a **b** c~~"]) {
    assert.deepEqual(
      markersFor(state(text, 0).doc).map((m) => [m.from, m.to]),
      [
        [0, 2],
        [4, 6],
        [7, 9],
        [11, 13],
      ]
    );
  }
});

test("削除記法でも選択方向・複数カーソルと Vim 行末位置を保持する", () => {
  const s = state("x ~~ab~~ y", 0);
  const tr = s.update({
    selection: EditorSelection.create(
      [EditorSelection.range(1, 3), EditorSelection.range(9, 7)],
      1
    ),
  });
  assert.equal(tr.state.selection.mainIndex, 1);
  assert.deepEqual(
    tr.state.selection.ranges.map((r) => [r.anchor, r.head]),
    [
      [1, 4],
      [9, 6],
    ]
  );
  assert.equal(
    state("~~ab~~", 2, true).update({ selection: { anchor: 5 } }).state.selection
      .main.head,
    3
  );
});

test("編集で削除記法が成立・不成立になったときに再判定する", () => {
  const s = state("~~a~", 4);
  const tr = s.update({
    changes: { from: 4, insert: "~" },
    selection: { anchor: 4 },
  });
  assert.equal(markersFor(tr.state.doc).length, 2);
  assert.equal(tr.state.doc.toString(), "~~a~~");
  assert.equal(tr.state.selection.main.head, 5);
  const broken = tr.state.update({ changes: { from: 4, to: 5 } }).state;
  assert.deepEqual(markersFor(broken.doc), []);
  assert.equal(broken.doc.toString(), "~~a~");
});
