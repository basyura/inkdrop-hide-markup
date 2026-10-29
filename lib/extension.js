const { EditorState, EditorSelection, StateField, StateEffect, Prec } = require("@codemirror/state");
const { Decoration, EditorView } = require("@codemirror/view");
const { markersFor } = require("./markers");
const { step, normalizePosition, standardSelection } = require("./selection");
const { VimSelection } = require("./vim-selection");
const {
  canNormalizeInsertionCursor, canHandleCaretArrow, canHandleMarkupReveal, canHandleVimInsertion,
} = require("./key-conditions");

function createExtension(isBlockCursor = () => false) {
  const vimSelection = new VimSelection();
  const reveal = StateEffect.define();
  const revealed = StateField.define({
    create() { return []; },
    update(value, tr) { return revealedRanges(tr); },
  });
  function revealedRanges(tr) {
    for (let index = tr.effects.length - 1; index >= 0; index--) {
      if (tr.effects[index].is(reveal)) return tr.effects[index].value;
    }
    return (tr.startState.field(revealed, false) || []).map(range => ({
      from: tr.changes.mapPos(range.from, -1),
      to: tr.changes.mapPos(range.to, 1),
    })).filter(range => tr.newSelection.ranges.some(selection =>
      selection.head >= range.from && selection.head < range.to));
  }
  function hiddenMarkers(doc, ranges) {
    return markersFor(doc).filter(mark => !ranges.some(range =>
      mark.from >= range.from && mark.to <= range.to));
  }
  function currentMarkers(view) {
    return hiddenMarkers(view.state.doc, view.state.field(revealed));
  }
  const insertBefore = StateEffect.define();
  const insertionBoundary = StateField.define({
    create() { return null; },
    update(value, tr) {
      value = insertionPosition(value, tr);
      return value != null && tr.newSelection.ranges.length === 1 &&
        tr.newSelection.main.empty && tr.newSelection.main.head === value &&
        markersFor(tr.newDoc).some(mark => mark.opening && mark.from === value)
        ? value : null;
    },
  });
  function insertionPosition(value, tr) {
    if (value != null) value = tr.changes.mapPos(value, 1);
    for (const effect of tr.effects) {
      if (effect.is(insertBefore)) value = effect.value;
    }
    return value;
  }
  const decorations = StateField.define({
    create(state) { return buildDecorations(state.doc); },
    update(value, tr) {
      return tr.docChanged || tr.selection || tr.effects.some(effect => effect.is(reveal))
        ? buildDecorations(tr.newDoc, hiddenMarkers(tr.newDoc, revealedRanges(tr))) : value;
    },
    provide: field => [
      EditorView.decorations.from(field),
      EditorView.atomicRanges.of(view => view.state.field(field)),
    ],
  });
  return [revealed, decorations, insertionBoundary, vimSelection.extension, Prec.highest(EditorView.domEventHandlers({
    keydown(event, view) {
      vimSelection.clearMotion();
      const vim = view.cm?.state?.vim;
      vimSelection.prepareDeletion(event, view);
      const boundary = view.state.field(insertionBoundary);
      if (boundary != null && ((vim && !vim.insertMode) || event.key === 'Escape')) {
        view.dispatch({ effects: insertBefore.of(null) });
      }
      let selection = view.state.selection;
      if (canNormalizeInsertionCursor(view, selection, vim)) {
        const mark = currentMarkers(view).find(mark => mark.opening
          ? mark.to === selection.main.head : mark.from === selection.main.head);
        if (mark) {
          view.dispatch({ selection: { anchor: mark.opening ? mark.from : mark.to } });
          selection = view.state.selection;
        }
      }
      if (canHandleCaretArrow(event, view, selection, vim)) {
        const forward = event.key === 'ArrowRight';
        const mark = currentMarkers(view).find(mark => forward
          ? mark.opening && mark.from === selection.main.head
          : !mark.opening && mark.to === selection.main.head);
        if (mark) {
          event.preventDefault();
          event.stopPropagation();
          view.dispatch({
            effects: insertBefore.of(null),
            selection: { anchor: step(view.state.doc, forward ? mark.to : mark.from, forward) },
          });
          return true;
        }
      }
      if (canHandleMarkupReveal(event, view, selection, vim)) {
        if (view.state.field(revealed).some(range =>
          selection.main.head >= range.from && selection.main.head < range.to)) return false;
        const markers = currentMarkers(view);
        const candidate = markers.filter(mark => mark.opening &&
          selection.main.head >= (isBlockCursor() ? mark.to : mark.from) && selection.main.head <= mark.rangeTo - 2)
          .sort((a, b) => (a.rangeTo - a.rangeFrom) - (b.rangeTo - b.rangeFrom))[0];
        if (candidate) {
          event.preventDefault();
          event.stopPropagation();
          view.dispatch({ effects: reveal.of([
            ...view.state.field(revealed),
            { from: candidate.rangeFrom, to: candidate.rangeTo },
          ]) });
          return true;
        }
      }
      if (canHandleVimInsertion(event, view, selection, vim)) {
        const line = view.state.doc.lineAt(selection.main.head);
        const firstNonWhitespace = line.from + Math.max(0, line.text.search(/\S/));
        if (event.key === 'a') {
          const mark = currentMarkers(view).find(mark => !mark.opening &&
            step(view.state.doc, selection.main.head, true) === mark.from);
          if (mark) {
            vimSelection.reserveMotion({state: view.state, head: mark.to, kind: 'append'});
          }
          return false;
        }
        const mark = currentMarkers(view).find(mark => mark.opening &&
          (event.key === 'I' ? mark.from === firstNonWhitespace : mark.to === selection.main.head));
        if (mark) {
          view.dispatch({ effects: insertBefore.of(mark.from), selection: { anchor: mark.from } });
        }
        return false;
      }
      vimSelection.prepareMotion(event, view, currentMarkers(view));
      return false;
    },
  })), EditorState.transactionFilter.of(tr => {
    const changeCursor = vimSelection.changeCursor(tr);
    if (changeCursor != null) return [tr, {selection: {anchor: changeCursor}}];
    if (!tr.selection && !tr.docChanged && !tr.effects.length) return tr;
    const rangesToReveal = revealedRanges(tr);
    const markers = hiddenMarkers(tr.newDoc, rangesToReveal);
    const boundary = insertionPosition(tr.startState.field(insertionBoundary, false) ?? null, tr);
    const block = isBlockCursor();
    const visual = vimSelection.handlesSelection(tr);
    let changed = false;
    let correctedVisualHead;
    const ranges = tr.newSelection.ranges.map((range, index) => {
      const previous = tr.startState.selection.ranges[index] || { head: range.anchor, anchor: range.anchor };
      if (visual) {
        const result = vimSelection.correctSelection(tr, range, previous, markers);
        changed = true;
        correctedVisualHead = {head: result.head, requested: result.requested};
        return result.range;
      }
      const corrected = standardSelection({tr, range, previous, markers, boundary, block,
        motion: vimSelection.motionFor(tr, range)});
      if (corrected !== range) changed = true;
      return corrected;
    });
    const needsRevealEffect = (tr.startState.field(revealed, false) || []).length > 0 ||
      tr.effects.some(effect => effect.is(reveal));
    return changed || needsRevealEffect ? [tr, {
      ...(changed ? { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex) } : {}),
      ...(needsRevealEffect ? { effects: reveal.of(rangesToReveal) } : {}),
      ...(correctedVisualHead == null ? {} : { annotations: vimSelection.cursorCorrection.of(correctedVisualHead) }),
      sequential: true,
    }] : tr;
  })];
}

function buildDecorations(doc, markers = markersFor(doc)) {
  return Decoration.set(markers.map(({ from, to }) =>
    Decoration.replace({ inclusive: false }).range(from, to)), true);
}

module.exports = { createExtension, normalizePosition };
