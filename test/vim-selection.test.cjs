const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EditorState } = require("@codemirror/state");
const { markersFor } = require("../lib/markers");
const { VimSelection } = require("../lib/vim-selection");

test("Vim 移動は入力バッファの回数を優先し、空なら getRepeat の回数で予約する", async () => {
  for (const marker of ["**", "~~"]) {
    for (const keyBuffer of [["3"], []]) {
      const state = EditorState.create({
        doc: `x ${marker}ab${marker} y`,
        selection: { anchor: 0 },
      });
      const selection = new VimSelection();
      const view = {
        state,
        cm: {
          state: {
            vim: {
              inputState: {
                keyBuffer,
                getRepeat() {
                  assert.equal(keyBuffer.length, 0);
                  return 3;
                },
              },
            },
          },
        },
      };
      selection.prepareMotion({ key: "l" }, view, markersFor(state.doc));
      assert.equal(selection.motion.head, 5);
      assert.equal(selection.motion.rawHead, 3);
      await Promise.resolve();
      assert.equal(selection.motion, null);
    }
  }
});

test("Vim 移動予約は絵文字の途中を要求する元の移動先を左右とも補正する", () => {
  for (const [key, start, repeat, head, rawHead] of [
    ["l", 1, 4, 10, 6],
    ["h", 9, 4, 0, 4],
  ]) {
    const state = EditorState.create({
      doc: "x **😀b** y",
      selection: { anchor: start },
    });
    const selection = new VimSelection();
    const view = {
      state,
      cm: {
        state: {
          vim: { inputState: { keyBuffer: [String(repeat)] } },
        },
      },
    };
    selection.prepareMotion({ key }, view, markersFor(state.doc));
    assert.equal(selection.motion.head, head);
    assert.equal(selection.motion.rawHead, rawHead);
    const tr = state.update({ selection: { anchor: rawHead } });
    assert.equal(selection.motionFor(tr, tr.newSelection.main), selection.motion);
    const other = state.update({ selection: { anchor: start } });
    assert.equal(selection.motionFor(other, other.newSelection.main), null);
  }
});

test("Visual の遅延再同期は元の要求位置に戻された場合だけ適用する", async () => {
  for (const current of [6, 4]) {
    const selection = new VimSelection();
    const state = EditorState.create({ doc: "x **ab** y" });
    const vim = { visualMode: true, sel: { head: { line: 0, ch: 6 } } };
    const view = { state, cm: { state: { vim } } };
    selection.view = view;
    const tr = state.update({
      annotations: selection.cursorCorrection.of({ head: 5, requested: 6 }),
    });
    selection.update({ view, state, transactions: [tr] });
    assert.equal(vim.sel.head.ch, 5);
    assert.equal(selection.visualHead, 5);
    vim.sel.head = { line: 0, ch: current };
    await Promise.resolve();
    assert.equal(vim.sel.head.ch, current === 6 ? 5 : current);
  }
});

test("Visual の遅延再同期は文書・選択・モード・ビューが変わると適用しない", async () => {
  for (const changed of ["document", "selection", "mode", "view"]) {
    const selection = new VimSelection();
    const state = EditorState.create({ doc: "x **ab** y" });
    const vim = { visualMode: true, sel: { head: { line: 0, ch: 6 } } };
    const view = { state, cm: { state: { vim } } };
    selection.view = view;
    const tr = state.update({
      annotations: selection.cursorCorrection.of({ head: 5, requested: 6 }),
    });
    selection.update({ view, state, transactions: [tr] });
    vim.sel.head = { line: 0, ch: 6 };
    if (changed === "document") {
      view.state = state.update({ changes: { from: 0, insert: "z" } }).state;
    } else if (changed === "selection") {
      view.state = state.update({ selection: { anchor: 1 } }).state;
    } else if (changed === "mode") {
      vim.visualMode = false;
    } else {
      selection.view = null;
    }
    await Promise.resolve();
    assert.equal(vim.sel.head.ch, 6);
  }
});
