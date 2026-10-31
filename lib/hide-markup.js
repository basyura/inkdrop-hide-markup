"use babel";

const { createExtension } = require("./extension");

let extension = null;

module.exports = {
  // エディタのロード後に拡張を登録し、初期カーソル位置を補正する。
  activate() {
    this.deactivate();
    // アクティブなエディタが Vim 通常モードのブロックカーソルを使うか判定する。
    const isBlockCursor = () => {
      const view = inkdrop.getActiveEditor();
      // アクティブなエディタがなければ、ブロックカーソルとして扱わない。
      if (!view) {
        return false;
      }
      const vim = view.cm?.state?.vim;
      // Vim 内部の状態が取得できる場合は、DOM のクラスより優先する。
      if (vim) {
        return !vim.insertMode && !vim.visualMode;
      }
      // 内部状態が取得できず、DOM でも Vim が無効なら対象外にする。
      if (!view.scrollDOM.classList.contains("cm-vimMode")) {
        return false;
      }
      const modes = view.dom.classList;
      // DOM から判定する場合は、挿入・Visual・置換モードを対象外にする。
      return (
        !modes.contains("vim-mode-insert") &&
        !modes.contains("vim-mode-visual") &&
        !modes.contains("vim-mode-replace")
      );
    };
    const currentExtension = (extension = createExtension(isBlockCursor));
    // 古い有効化処理の通知を除外して、拡張を登録する。
    inkdrop.ensureEditorLoaded(() => {
      // 無効化済みか、再有効化で拡張が置き換わっていれば処理しない。
      if (extension !== currentExtension) {
        return;
      }
      inkdrop.commands.dispatch(document.body, "editor:add-extension", {
        extension: currentExtension,
      });
      const view = inkdrop.getActiveEditor();
      if (view) {
        view.dispatch({ selection: view.state.selection });
      }
    });
  },

  // 登録した拡張を解除し、遅延ロード通知が再登録しないよう状態を初期化する。
  deactivate() {
    // 拡張が作成されている場合だけ解除を通知する。
    if (extension) {
      inkdrop.commands.dispatch(document.body, "editor:remove-extension", {
        extension,
      });
    }
    extension = null;
  },
};
