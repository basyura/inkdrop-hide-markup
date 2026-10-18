const { EditorState, EditorSelection, StateField, StateEffect, Prec, findClusterBreak } = require("@codemirror/state");
const { Decoration, EditorView } = require("@codemirror/view");
const { markersFor } = require("./markers");

function step(doc, pos, forward) {
  const line = doc.lineAt(pos);
  if (forward ? pos === line.to : pos === line.from) {
    return Math.max(0, Math.min(doc.length, pos + (forward ? 1 : -1)));
  }
  return line.from + findClusterBreak(line.text, pos - line.from, forward);
}

function normalizePosition(doc, markers, pos, oldPos, block, cursor, caretMove = false) {
  const forward = pos >= oldPos;
  for (let pass = 0; pass <= markers.length; pass++) {
    const before = pos;
    for (const mark of markers) {
      if (mark.opening && !block && cursor && pos >= mark.from && pos <= mark.to) {
        pos = caretMove && forward && oldPos === mark.from && pos > mark.from
          ? step(doc, mark.to, true) : mark.from;
      } else if (mark.opening && pos >= mark.from && pos < mark.to) {
        pos = !forward && oldPos === mark.to && mark.from > doc.lineAt(mark.from).from
          ? step(doc, mark.from, false) : mark.to;
      } else if (!mark.opening && !block && cursor && pos >= mark.from && pos <= mark.to) {
        pos = caretMove && !forward && oldPos === mark.to && pos < mark.to
          ? step(doc, mark.from, false) : mark.to;
      } else if (!mark.opening && pos >= mark.from && pos < mark.to) {
        if (block && cursor) {
          pos = forward ? mark.to : step(doc, mark.from, false);
        } else if (pos > mark.from) {
          pos = forward
            ? (oldPos === mark.from ? step(doc, mark.to, true) : mark.to)
            : mark.from;
        }
      } else if (!mark.opening && !cursor && pos === mark.to && !block &&
                 forward && oldPos === mark.from) {
        pos = step(doc, mark.to, true);
      } else if (!mark.opening && !cursor && pos === mark.to && !block &&
                 !forward && oldPos > mark.to) {
        pos = mark.from;
      }
    }
    if (block && cursor && pos === doc.lineAt(pos).to && pos > doc.lineAt(pos).from) {
      pos = step(doc, pos, false);
      for (let index = markers.length - 1; index >= 0; index--) {
        const mark = markers[index];
        if (pos >= mark.from && pos < mark.to) pos = step(doc, mark.from, false);
      }
    }
    if (before === pos) break;
  }
  return pos;
}

function createExtension(isBlockCursor = () => false) {
  let pendingMotion = null;
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
  return [revealed, decorations, insertionBoundary, Prec.highest(EditorView.domEventHandlers({
    keydown(event, view) {
      pendingMotion = null;
      const vim = view.cm?.state?.vim;
      const boundary = view.state.field(insertionBoundary);
      if (boundary != null && ((vim && !vim.insertMode) || event.key === 'Escape')) {
        view.dispatch({ effects: insertBefore.of(null) });
      }
      let selection = view.state.selection;
      if ((!vim || (vim.insertMode && !vim.visualMode)) && !view.composing &&
          selection.ranges.length === 1 && selection.main.empty) {
        const mark = currentMarkers(view).find(mark => mark.opening
          ? mark.to === selection.main.head : mark.from === selection.main.head);
        if (mark) {
          view.dispatch({ selection: { anchor: mark.opening ? mark.from : mark.to } });
          selection = view.state.selection;
        }
      }
      if ((!vim || (vim.insertMode && !vim.visualMode)) &&
          ['ArrowLeft', 'ArrowRight'].includes(event.key) && !event.ctrlKey && !event.altKey &&
          !event.metaKey && !event.shiftKey && !view.composing &&
          selection.ranges.length === 1 && selection.main.empty) {
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
      if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey &&
          !event.shiftKey && !view.composing && selection.ranges.length === 1 && selection.main.empty &&
          !vim?.expectLiteralNext && !vim?.inputState?.operator) {
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
      if (['i', 'I', 'a'].includes(event.key) && vim && !vim.insertMode && !vim.visualMode &&
          !vim.expectLiteralNext && !vim.inputState?.operator &&
          !(vim.inputState?.keyBuffer?.join('') || '').replace(/^\d+/, '') &&
          !event.ctrlKey && !event.altKey && !event.metaKey && !view.composing &&
          selection.ranges.length === 1 && selection.main.empty) {
        const line = view.state.doc.lineAt(selection.main.head);
        const firstNonWhitespace = line.from + Math.max(0, line.text.search(/\S/));
        if (event.key === 'a') {
          const mark = currentMarkers(view).find(mark => !mark.opening &&
            step(view.state.doc, selection.main.head, true) === mark.from);
          if (mark) {
            const motion = pendingMotion = { state: view.state, head: mark.to, append: true };
            queueMicrotask(() => { if (pendingMotion === motion) pendingMotion = null; });
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
      if (!vim || vim.insertMode || vim.visualMode || vim.inputState?.operator ||
          event.ctrlKey || event.altKey || event.metaKey || view.composing ||
          !['h', 'l', 'ArrowLeft', 'ArrowRight'].includes(event.key) ||
          view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return false;
      const forward = event.key === 'l' || event.key === 'ArrowRight';
      const buffered = vim.inputState?.keyBuffer?.join('') || '';
      if (vim.expectLiteralNext || (buffered && !/^\d+$/.test(buffered))) return false;
      const repeat = /^\d+$/.test(buffered) ? Number(buffered) : vim.inputState?.getRepeat?.() || 1;
      const doc = view.state.doc;
      const markers = currentMarkers(view);
      const line = doc.lineAt(view.state.selection.main.head);
      const start = view.state.selection.main.head;
      let head = start;
      let skippedMarker = false;
      for (let i = 0; i < Math.min(repeat, line.length + 1); i++) {
        const stepped = step(doc, head, forward);
        const next = normalizePosition(doc, markers, stepped, head, true, true);
        if (next !== stepped && markers.some(mark =>
          stepped >= mark.from && stepped < mark.to)) skippedMarker = true;
        if (next < line.from || next >= line.to || next === head) break;
        head = next;
      }
      if (!skippedMarker) return false;
      // Vim counts document characters. Only replace that uncorrected target;
      // another plugin may already have moved across its own hidden range.
      let rawHead = Math.max(line.from, Math.min(line.to - 1, start + (forward ? repeat : -repeat)));
      const code = doc.sliceString(rawHead, rawHead + 1).charCodeAt(0);
      if (code >= 0xDC00 && code <= 0xDFFF) {
        rawHead += rawHead < start ? -1 : 1;
        if (rawHead >= line.to) rawHead -= 2;
      }
      const motion = pendingMotion = { state: view.state, head, rawHead };
      queueMicrotask(() => { if (pendingMotion === motion) pendingMotion = null; });
      return false;
    },
  })), EditorState.transactionFilter.of(tr => {
    const rangesToReveal = revealedRanges(tr);
    const markers = hiddenMarkers(tr.newDoc, rangesToReveal);
    const boundary = insertionPosition(tr.startState.field(insertionBoundary, false) ?? null, tr);
    const block = isBlockCursor();
    let changed = false;
    const ranges = tr.newSelection.ranges.map((range, index) => {
      const previous = tr.startState.selection.ranges[index] || { head: range.anchor, anchor: range.anchor };
      const oldHead = tr.changes.mapPos(previous.head);
      const oldAnchor = tr.changes.mapPos(previous.anchor);
      const motion = pendingMotion;
      const target = motion && motion.state === tr.startState && !tr.docChanged && range.empty &&
        (motion.append || range.head === motion.rawHead)
        ? motion.head : range.head;
      const head = motion?.append && motion.state === tr.startState && !tr.docChanged && range.empty
        ? target : range.empty && target === boundary && markers.some(mark => mark.opening && mark.from === boundary)
        ? target : normalizePosition(tr.newDoc, markers, target, oldHead, block, range.empty,
          !tr.docChanged && tr.isUserEvent('select') && !tr.isUserEvent('select.pointer'));
      const anchor = range.empty ? head
        : normalizePosition(tr.newDoc, markers, range.anchor, oldAnchor, false, false);
      if (head === range.head && anchor === range.anchor) return range;
      changed = true;
      return range.empty ? EditorSelection.cursor(head, range.assoc)
        : EditorSelection.range(anchor, head);
    });
    const needsRevealEffect = (tr.startState.field(revealed, false) || []).length > 0 ||
      tr.effects.some(effect => effect.is(reveal));
    return changed || needsRevealEffect ? [tr, {
      ...(changed ? { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex) } : {}),
      ...(needsRevealEffect ? { effects: reveal.of(rangesToReveal) } : {}),
      sequential: true,
    }] : tr;
  })];
}

function buildDecorations(doc, markers = markersFor(doc)) {
  return Decoration.set(markers.map(({ from, to }) =>
    Decoration.replace({ inclusive: false }).range(from, to)), true);
}

module.exports = { createExtension, normalizePosition };
