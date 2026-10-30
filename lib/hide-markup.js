"use babel";

const { createExtension } = require("./extension");

let environment = null;
let extension = null;
let registered = false;

module.exports = {
  // エディタのロード後に拡張を一度だけ登録し、初期カーソル位置を補正する。
  activate(env = inkdrop) {
    this.deactivate();
    environment = env;
    // アクティブなエディタが Vim 通常モードのブロックカーソルを使うか判定する。
    const blockCursor = () => {
      const view = env.getActiveEditor();
      if (!view) return false;
      const vim = view.cm?.state?.vim;
      if (vim) return !vim.insertMode && !vim.visualMode;
      return (
        view.scrollDOM.classList.contains("cm-vimMode") &&
        !view.dom.classList.contains("vim-mode-insert") &&
        !view.dom.classList.contains("vim-mode-visual") &&
        !view.dom.classList.contains("vim-mode-replace")
      );
    };
    const currentExtension = (extension = createExtension(blockCursor));
    // 古い有効化処理や登録済みの通知を除外して、拡張を登録する。
    env.ensureEditorLoaded(() => {
      if (extension !== currentExtension || registered) return;
      env.commands.dispatch(document.body, "editor:add-extension", {
        extension: currentExtension,
      });
      registered = true;
      const view = env.getActiveEditor();
      if (view) view.dispatch({ selection: view.state.selection });
    });
  },

  // 登録した拡張を解除し、遅延ロード通知が再登録しないよう状態を初期化する。
  deactivate() {
    if (registered) {
      environment.commands.dispatch(document.body, "editor:remove-extension", {
        extension,
      });
    }
    registered = false;
    extension = null;
    environment = null;
  },
};
