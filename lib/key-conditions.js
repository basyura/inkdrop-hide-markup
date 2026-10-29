const { isCharacterVisual } = require("./selection");

function hasCommandModifier(event) {
  return event.ctrlKey || event.altKey || event.metaKey;
}

function isUnmodifiedKey(event) {
  return !hasCommandModifier(event) && !event.shiftKey;
}

function hasSingleCursor(selection) {
  return selection.ranges.length === 1 && selection.main.empty;
}

function isVimCommandReady(vim) {
  return !vim?.expectLiteralNext && !vim?.inputState?.operator;
}

function hasOnlyVimCount(vim) {
  const buffered = vim.inputState?.keyBuffer?.join('') || '';
  return /^\d*$/.test(buffered);
}

function canNormalizeInsertionCursor(view, selection, vim) {
  const inserting = !vim || (!!vim.insertMode && !vim.visualMode);
  return inserting && !view.composing && hasSingleCursor(selection);
}

function canHandleCaretArrow(event, view, selection, vim) {
  return ['ArrowLeft', 'ArrowRight'].includes(event.key) && isUnmodifiedKey(event) &&
    canNormalizeInsertionCursor(view, selection, vim);
}

function canHandleMarkupReveal(event, view, selection, vim) {
  return event.key === 'Enter' && isUnmodifiedKey(event) && !view.composing &&
    hasSingleCursor(selection) && isVimCommandReady(vim);
}

function canHandleVimInsertion(event, view, selection, vim) {
  const normalMode = !!vim && !vim.insertMode && !vim.visualMode;
  return ['i', 'I', 'a'].includes(event.key) && normalMode &&
    isVimCommandReady(vim) && hasOnlyVimCount(vim) && !hasCommandModifier(event) &&
    !view.composing && hasSingleCursor(selection);
}

function canPrepareVisualDeletion(event, view, vim) {
  const selection = view.state.selection;
  return ['d', 'x'].includes(event.key) && isUnmodifiedKey(event) &&
    !view.composing && isCharacterVisual(vim) && !vim.expectLiteralNext &&
    selection.ranges.length === 1 && !selection.main.empty;
}

function canReserveVimMotion(event, view, vim) {
  const motionMode = !!vim && !vim.insertMode && !vim.visualLine && !vim.visualBlock;
  const selection = view.state.selection;
  return motionMode && ['h', 'l', 'ArrowLeft', 'ArrowRight'].includes(event.key) &&
    isVimCommandReady(vim) && hasOnlyVimCount(vim) && !hasCommandModifier(event) &&
    !view.composing && selection.ranges.length === 1 && (vim.visualMode || selection.main.empty);
}

module.exports = {
  canNormalizeInsertionCursor, canHandleCaretArrow, canHandleMarkupReveal,
  canHandleVimInsertion, canPrepareVisualDeletion, canReserveVimMotion,
};
