"use babel";

const { createExtension } = require("./extension");

let environment = null;
let extension = null;
let registered = false;

module.exports = {
  activate(env = inkdrop) {
    this.deactivate();
    environment = env;
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
