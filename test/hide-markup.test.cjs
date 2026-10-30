const { test } = require("node:test");
const assert = require("node:assert/strict");
const extension = require("../lib/extension");

test("ブロックカーソル判定は Vim 内部状態を優先し、取得できなければ DOM のモードを使う", (t) => {
  let isBlockCursor;
  t.mock.method(extension, "createExtension", (predicate) => {
    isBlockCursor = predicate;
    return [];
  });
  const plugin = require("../lib/hide-markup");
  let activeView = null;
  plugin.activate({
    getActiveEditor: () => activeView,
    ensureEditorLoaded() {},
  });
  assert.equal(isBlockCursor(), false);

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
      isBlockCursor(),
      expected,
      JSON.stringify({ vim, vimEnabled, modeClasses })
    );
  }
  plugin.deactivate();
});
