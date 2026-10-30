const { Direction } = require("@codemirror/view");
const { step, isCharacterVisual } = require("./selection");

const nativeCursorSelector =
  ".cm-vimCursorLayer:not(.hide-markup-cursor-layer) .cm-cursor-primary";

// Vim と同じ DOM 要素を操作せず、論理上の移動先に専用カーソルを重ねる。
// 選択の端点と論理上の移動先が異なる場合に、専用の Vim カーソルを描画する。
function createVisualCursor(editor, getHead) {
  const layer = document.createElement("div");
  layer.className = "cm-cursorLayer cm-vimCursorLayer hide-markup-cursor-layer";
  layer.setAttribute("aria-hidden", "true");
  editor.scrollDOM.appendChild(layer);
  let hiddenCursor = null;
  let destroyed = false;
  const observer = new MutationObserver(schedule);
  const observation = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style"],
  };
  const measurement = { read: measure, write: draw };
  observer.observe(editor.scrollDOM, observation);

  // 論理上の移動先の文字と、拡大率・スクロールを考慮した描画座標を取得する。
  function measure() {
    if (destroyed) return null;
    const head = getHead();
    const selection = editor.state.selection;
    if (
      head == null ||
      !isCharacterVisual(editor.cm?.state?.vim) ||
      selection.ranges.length !== 1
    )
      return null;
    const range = selection.main;
    const renderedHead = range.anchor < range.head ? range.head - 1 : range.head;
    if (renderedHead === head) return null;
    const coords = editor.coordsForChar(head) || editor.coordsAtPos(head);
    if (!coords) return null;
    const bounds = editor.scrollDOM.getBoundingClientRect();
    const origin =
      editor.textDirection === Direction.LTR
        ? bounds.left
        : bounds.right - editor.scrollDOM.clientWidth;
    return {
      left: (coords.left - origin) / editor.scaleX + editor.scrollDOM.scrollLeft,
      top: (coords.top - bounds.top) / editor.scaleY + editor.scrollDOM.scrollTop,
      text:
        editor.state.sliceDoc(head, step(editor.state.doc, head, true)) || "\u00a0",
    };
  }

  // 専用カーソルの描画時に隠した標準カーソルの表示状態を元に戻す。
  function restoreNativeCursor() {
    if (!hiddenCursor) return;
    hiddenCursor.element.style.visibility = hiddenCursor.visibility;
    hiddenCursor = null;
  }

  // 計測した位置に専用カーソルを描画し、重なる標準カーソルを隠す。
  function draw(position) {
    if (destroyed) return;
    observer.disconnect();
    restoreNativeCursor();
    layer.replaceChildren();
    const native = position && editor.scrollDOM.querySelector(nativeCursorSelector);
    if (native) {
      const { left, top, text } = position;
      const cursor = native.cloneNode(false);
      cursor.style.left = `${left}px`;
      cursor.style.top = `${top}px`;
      cursor.textContent = text;
      layer.appendChild(cursor);
      hiddenCursor = { element: native, visibility: native.style.visibility };
      native.style.visibility = "hidden";
    }
    observer.observe(editor.scrollDOM, observation);
  }

  // 破棄されていなければ、次回のレイアウト計測とカーソル描画を予約する。
  function schedule() {
    if (!destroyed) editor.requestMeasure(measurement);
  }

  return {
    schedule,
    // 監視と専用レイヤーを解除し、標準カーソルの表示状態を復元する。
    destroy() {
      destroyed = true;
      observer.disconnect();
      restoreNativeCursor();
      layer.remove();
    },
  };
}

module.exports = { createVisualCursor };
