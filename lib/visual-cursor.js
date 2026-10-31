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
    // 破棄後に予約済みの計測が実行されても、描画情報を返さない。
    if (destroyed) {
      return null;
    }

    const head = getHead();
    // 論理上の移動先がなければ、専用カーソルは不要。
    if (head == null) {
      return null;
    }
    // 文字単位の Visual モード以外は描画しない。
    if (!isCharacterVisual(editor.cm?.state?.vim)) {
      return null;
    }

    const selection = editor.state.selection;
    // 複数選択では、単一の専用カーソルによる補正を行わない。
    if (selection.ranges.length !== 1) {
      return null;
    }

    const range = selection.main;
    const renderedHead = range.anchor < range.head ? range.head - 1 : range.head;
    // 標準カーソルと論理上の移動先が一致する場合は、描画を置き換えない。
    if (renderedHead === head) {
      return null;
    }

    const coords = editor.coordsForChar(head) || editor.coordsAtPos(head);
    // 移動先の画面座標を取得できなければ描画しない。
    if (!coords) {
      return null;
    }

    const bounds = editor.scrollDOM.getBoundingClientRect();
    let horizontalOrigin = bounds.left;
    // 右から左へ書く場合は、スクロール領域の右端から表示幅を引いた位置を基準にする。
    if (editor.textDirection !== Direction.LTR) {
      horizontalOrigin = bounds.right - editor.scrollDOM.clientWidth;
    }

    const left =
      (coords.left - horizontalOrigin) / editor.scaleX + editor.scrollDOM.scrollLeft;
    const top =
      (coords.top - bounds.top) / editor.scaleY + editor.scrollDOM.scrollTop;
    const text =
      editor.state.sliceDoc(head, step(editor.state.doc, head, true)) || "\u00a0";

    return { left, top, text };
  }

  // 専用カーソルの描画時に隠した標準カーソルの表示状態を元に戻す。
  function restoreNativeCursor() {
    // 前回の描画で隠した標準カーソルがある場合だけ復元する。
    if (!hiddenCursor) {
      return;
    }

    hiddenCursor.element.style.visibility = hiddenCursor.visibility;
    hiddenCursor = null;
  }

  // 計測した位置に専用カーソルを描画し、重なる標準カーソルを隠す。
  function draw(position) {
    // 破棄後に予約済みの描画が実行されても、DOM を操作しない。
    if (destroyed) {
      return;
    }

    // 自分自身の DOM 更新によって再描画が予約されないよう、監視を一時停止する。
    observer.disconnect();
    restoreNativeCursor();
    layer.replaceChildren();
    drawCursor(position);

    // 描画対象の有無にかかわらず、標準カーソルの更新の監視を再開する。
    observer.observe(editor.scrollDOM, observation);
  }

  // 標準カーソルの見た目を複製して、計測した位置と文字で描画する。
  function drawCursor(position) {
    // 計測結果がなければ、標準カーソルの表示を維持する。
    if (!position) {
      return;
    }

    const nativeCursor = editor.scrollDOM.querySelector(nativeCursorSelector);
    // 複製元の標準カーソルがなければ、専用カーソルを作成しない。
    if (!nativeCursor) {
      return;
    }

    const { left, top, text } = position;
    const cursor = nativeCursor.cloneNode(false);
    cursor.style.left = `${left}px`;
    cursor.style.top = `${top}px`;
    cursor.textContent = text;
    layer.appendChild(cursor);

    hiddenCursor = {
      element: nativeCursor,
      visibility: nativeCursor.style.visibility,
    };
    nativeCursor.style.visibility = "hidden";
  }

  // 破棄されていなければ、次回のレイアウト計測とカーソル描画を予約する。
  function schedule() {
    // 破棄後は計測や描画を追加で予約しない。
    if (destroyed) {
      return;
    }

    editor.requestMeasure(measurement);
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
