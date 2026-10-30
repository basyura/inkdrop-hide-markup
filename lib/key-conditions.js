const { isCharacterVisual } = require("./selection");

// Ctrl・Alt・Meta のいずれかの修飾キーが押されているか判定する。
function hasCommandModifier(event) {
  return event.ctrlKey || event.altKey || event.metaKey;
}

// Shift も含めて修飾キーなしの入力か判定する。
function isUnmodifiedKey(event) {
  return !hasCommandModifier(event) && !event.shiftKey;
}

// 選択範囲が一つで、文字列を選択していないか判定する。
function hasSingleCursor(selection) {
  return selection.ranges.length === 1 && selection.main.empty;
}

// Vim がリテラル入力や演算子の続きの入力を待っていないか判定する。
function isVimCommandReady(vim) {
  return !vim.expectLiteralNext && !vim.inputState.operator;
}

// Vim の入力バッファが空か、回数指定の数字だけか判定する。
function hasOnlyVimCount(vim) {
  const buffered = vim.inputState.keyBuffer.join("");
  return /^\d*$/.test(buffered);
}

// 通常エディタまたは Vim 挿入モードで単一カーソルを補正できるか判定する。
function canNormalizeInsertionCursor(view, selection, vim) {
  const inserting = !vim || (!!vim.insertMode && !vim.visualMode);
  return inserting && !view.composing && hasSingleCursor(selection);
}

// 入口で判定した挿入カーソルの状態と、修飾なしの左右矢印を確認する。
function canHandleCaretArrow(event, insertionCursor) {
  return (
    insertionCursor &&
    ["ArrowLeft", "ArrowRight"].includes(event.key) &&
    isUnmodifiedKey(event)
  );
}

// Enter による記号の一時表示を適用できる入力状態か判定する。
function canHandleMarkupReveal(event, view, selection, vim) {
  return (
    event.key === "Enter" &&
    isUnmodifiedKey(event) &&
    !view.composing &&
    hasSingleCursor(selection) &&
    (!vim || isVimCommandReady(vim))
  );
}

// Vim 通常モードの i・I・a に挿入位置の特例を適用できるか判定する。
function canHandleVimInsertion(event, view, selection, vim) {
  const normalMode = !!vim && !vim.insertMode && !vim.visualMode;
  return (
    ["i", "I", "a"].includes(event.key) &&
    normalMode &&
    isVimCommandReady(vim) &&
    hasOnlyVimCount(vim) &&
    !hasCommandModifier(event) &&
    !view.composing &&
    hasSingleCursor(selection)
  );
}

// Vim の文字単位 Visual 選択で d・x の削除範囲を準備できるか判定する。
function canPrepareVisualDeletion(event, view, vim) {
  const selection = view.state.selection;
  return (
    ["d", "x"].includes(event.key) &&
    isUnmodifiedKey(event) &&
    !view.composing &&
    isCharacterVisual(vim) &&
    !vim.expectLiteralNext &&
    selection.ranges.length === 1 &&
    !selection.main.empty
  );
}

// Vim の左右移動に、非表示記号を除いた移動先を予約できるか判定する。
function canReserveVimMotion(event, view, vim) {
  const motionMode = !!vim && !vim.insertMode && !vim.visualLine && !vim.visualBlock;
  const selection = view.state.selection;
  return (
    motionMode &&
    ["h", "l", "ArrowLeft", "ArrowRight"].includes(event.key) &&
    isVimCommandReady(vim) &&
    hasOnlyVimCount(vim) &&
    !hasCommandModifier(event) &&
    !view.composing &&
    selection.ranges.length === 1 &&
    (vim.visualMode || selection.main.empty)
  );
}

module.exports = {
  canNormalizeInsertionCursor,
  canHandleCaretArrow,
  canHandleMarkupReveal,
  canHandleVimInsertion,
  canPrepareVisualDeletion,
  canReserveVimMotion,
};
