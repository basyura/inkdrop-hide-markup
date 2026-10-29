const { Direction } = require("@codemirror/view");
const { step, isCharacterVisual } = require("./selection");

const nativeCursorSelector = '.cm-vimCursorLayer:not(.hide-markup-cursor-layer) .cm-cursor-primary';

// Vim draws from the expanded selection's endpoint, which can be a hidden
// delimiter. Draw a separate cursor at the logical head rather than competing
// with Vim for the position and text of the same DOM element.
function createVisualCursor(editor, getHead) {
  const layer = document.createElement('div');
  layer.className = 'cm-cursorLayer cm-vimCursorLayer hide-markup-cursor-layer';
  layer.setAttribute('aria-hidden', 'true');
  editor.scrollDOM.appendChild(layer);
  let hiddenCursor = null;
  let destroyed = false;
  const observer = new MutationObserver(schedule);
  const observation = {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['style']};
  const measurement = {read: measure, write: draw};
  observer.observe(editor.scrollDOM, observation);

  function needsVisualCursor(head) {
    const selection = editor.state.selection;
    if (head == null || !isCharacterVisual(editor.cm?.state?.vim) || selection.ranges.length !== 1) return false;
    const range = selection.main;
    const renderedHead = range.anchor < range.head ? range.head - 1 : range.head;
    return renderedHead !== head;
  }

  function measure() {
    if (destroyed) return null;
    const head = getHead();
    if (!needsVisualCursor(head)) return null;
    const coords = editor.coordsForChar?.(head) || editor.coordsAtPos(head);
    if (!coords) return null;
    const bounds = editor.scrollDOM.getBoundingClientRect();
    const origin = editor.textDirection === Direction.LTR
      ? bounds.left : bounds.right - editor.scrollDOM.clientWidth;
    return {
      left: (coords.left - origin) / editor.scaleX + editor.scrollDOM.scrollLeft,
      top: (coords.top - bounds.top) / editor.scaleY + editor.scrollDOM.scrollTop,
      text: editor.state.sliceDoc(head, step(editor.state.doc, head, true)) || '\u00a0',
    };
  }

  function restoreNativeCursor() {
    if (!hiddenCursor) return;
    hiddenCursor.element.style.visibility = hiddenCursor.visibility;
    hiddenCursor = null;
  }

  function draw(position) {
    if (destroyed) return;
    observer.disconnect();
    try {
      restoreNativeCursor();
      layer.replaceChildren();
      if (!position) return;
      const native = editor.scrollDOM.querySelector(nativeCursorSelector);
      if (!native) return;
      const {left, top, text} = position;
      const cursor = native.cloneNode(false);
      cursor.style.left = `${left}px`;
      cursor.style.top = `${top}px`;
      cursor.textContent = text;
      layer.appendChild(cursor);
      hiddenCursor = {element:native, visibility:native.style.visibility};
      native.style.visibility = 'hidden';
    } finally {
      observer.observe(editor.scrollDOM, observation);
    }
  }

  function schedule() {
    if (!destroyed) editor.requestMeasure(measurement);
  }

  return {
    schedule,
    destroy() {
      destroyed = true;
      observer.disconnect();
      restoreNativeCursor();
      layer.remove();
    },
  };
}

module.exports = { createVisualCursor };
