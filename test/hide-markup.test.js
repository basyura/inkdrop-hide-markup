import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EditorState } from "@codemirror/state";
import * as plugin from "../lib/hide-markup.js";

test("package.json のエントリから ES Module としてライフサイクル関数を読み込める", async () => {
  const packageUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(await readFile(packageUrl, "utf8"));
  assert.equal(manifest.type, "module");
  const entry = await import(new URL(manifest.main, packageUrl).href);
  assert.equal(entry, plugin);
  assert.equal(typeof entry.activate, "function");
  assert.equal(typeof entry.deactivate, "function");
});

test("ブロックカーソル判定は Vim 内部状態を優先し、取得できなければ DOM のモードを使う", (t) => {
  let extension;
  let activeView = null;
  global.document = { body: {} };
  global.inkdrop = {
    getActiveEditor: () => activeView,
    ensureEditorLoaded() {},
    commands: {
      dispatch(target, command, args) {
        extension = args.extension;
      },
    },
  };
  t.after(() => delete global.inkdrop);
  t.after(() => delete global.document);
  plugin.activate();
  plugin.deactivate();
  const state = EditorState.create({ doc: "**ab**", extensions: extension });
  const cursorPosition = () =>
    state.update({ selection: { anchor: 2 } }).state.selection.main.head;
  assert.equal(cursorPosition(), 0);

  for (const [vim, vimEnabled, modeClasses, expected] of [
    [{ insertMode: false, visualMode: false }, false, ["vim-mode-insert"], true],
    [{ insertMode: true, visualMode: false }, true, [], false],
    [{ insertMode: false, visualMode: true }, true, [], false],
    [undefined, false, [], false],
    [undefined, true, [], true],
    [undefined, true, ["vim-mode-insert"], false],
    [undefined, true, ["vim-mode-visual"], false],
    [undefined, true, ["vim-mode-replace"], false],
  ]) {
    activeView = {
      cm: vim ? { state: { vim } } : undefined,
      scrollDOM: {
        classList: {
          contains: (name) => vimEnabled && name === "cm-vimMode",
        },
      },
      dom: { classList: { contains: (name) => modeClasses.includes(name) } },
    };
    assert.equal(
      cursorPosition(),
      expected ? 2 : 0,
      JSON.stringify({ vim, vimEnabled, modeClasses })
    );
  }
  plugin.deactivate();
});

test("ロード前でも作成済みの拡張を解除し、無効化を繰り返しても再通知しない", (t) => {
  const dispatch = t.mock.fn();
  global.document = { body: {} };
  global.inkdrop = {
    ensureEditorLoaded() {},
    commands: { dispatch },
  };
  t.after(() => delete global.inkdrop);
  t.after(() => delete global.document);

  plugin.deactivate();
  assert.equal(dispatch.mock.callCount(), 0);
  plugin.activate();
  plugin.deactivate();
  assert.equal(dispatch.mock.callCount(), 1);
  const [target, command, { extension: removed }] = dispatch.mock.calls[0].arguments;
  assert.equal(target, document.body);
  assert.equal(command, "editor:remove-extension");
  assert.ok(removed);
  plugin.deactivate();
  assert.equal(dispatch.mock.callCount(), 1);
});
