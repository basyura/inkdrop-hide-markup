const { Annotation, EditorState, EditorSelection, StateField, StateEffect, Prec, findClusterBreak } = require("@codemirror/state");
const { Decoration, EditorView, ViewPlugin } = require("@codemirror/view");
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
  let view = null;
  let visualHead = null;
  let pendingVisualChange = null;
  const visualCursor = Annotation.define();
  const visualSync = ViewPlugin.define(editor => {
    view = editor;
    let pendingFrame = null;
    let adjustedCursor = null;
    const cursorObserver = new MutationObserver(() => scheduleCursor());
    function scheduleCursor() {
      if (pendingFrame != null) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        cursorObserver.disconnect();
        try {
          if (adjustedCursor) {
            const {element, originalText, shownText, originalLeft} = adjustedCursor;
            element.style.left = originalLeft;
            if (element.textContent === shownText) element.textContent = originalText;
            adjustedCursor = null;
          }
          const vim = editor.cm?.state?.vim;
          const selection = editor.state.selection.main;
          if (visualHead == null || !vim?.visualMode || vim.visualLine || vim.visualBlock ||
              editor.state.selection.ranges.length !== 1) return;
          const renderedHead = selection.anchor < selection.head ? selection.head - 1 : selection.head;
          if (renderedHead === visualHead) return;
          const element = editor.scrollDOM.querySelector('.cm-vimCursorLayer .cm-cursor-primary');
          const coords = editor.coordsForChar?.(visualHead) || editor.coordsAtPos(visualHead);
          if (!element || !coords) return;
          const originalLeft = element.style.left;
          const originalText = element.textContent;
          const shownText = editor.state.sliceDoc(visualHead, step(editor.state.doc, visualHead, true)) || '\u00a0';
          element.style.left = `${parseFloat(originalLeft) + (coords.left - element.getBoundingClientRect().left) / editor.scaleX}px`;
          if (originalText !== shownText) element.textContent = shownText;
          adjustedCursor = {element, originalText, shownText, originalLeft};
        } finally {
          cursorObserver.observe(editor.scrollDOM, {subtree:true, childList:true, characterData:true});
        }
      });
    }
    cursorObserver.observe(editor.scrollDOM, {subtree:true, childList:true, characterData:true});
    return {
      update(update) {
        scheduleCursor();
        const cm = update.view.cm;
        const vimState = cm?.state?.vim;
        if (update.docChanged || pendingVisualChange?.operation !== cm?.curOp) pendingVisualChange = null;
        if (update.docChanged && !update.view.composing && cm?.curOp?.isVimOp &&
            vimState?.visualMode && !vimState.insertMode && !vimState.visualLine && !vimState.visualBlock &&
            vimState.lastEditInputState?.operator === 'change') {
          for (const tr of update.transactions) {
            const selection = tr.startState.selection;
            if (selection.ranges.length !== 1 || selection.main.empty) continue;
            const doc = tr.startState.doc;
            const offset = pos => { const line = doc.line(pos.line + 1); return line.from + Math.min(pos.ch, line.length); };
            const logicalFrom = Math.min(offset(vimState.sel.anchor), offset(vimState.sel.head));
            if (logicalFrom <= selection.main.from) continue;
            const changes = [];
            tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => changes.push({fromA, toA, fromB, inserted}));
            if (changes.length !== 1 || changes[0].fromA !== selection.main.from ||
                changes[0].toA !== selection.main.to || changes[0].inserted.length) continue;
            const line = tr.newDoc.lineAt(changes[0].fromB);
            pendingVisualChange = {operation: cm.curOp, head: changes[0].fromB,
              requestedHead: line.from + Math.min(logicalFrom - doc.lineAt(logicalFrom).from, line.length)};
          }
        }
        if (update.docChanged || update.selectionSet) visualHead = null;
        const vim = update.view.cm?.state?.vim;
        if (!vim?.visualMode || vim.visualLine || vim.visualBlock) return;
        for (const tr of update.transactions) {
          const correction = tr.annotation(visualCursor);
          if (correction == null) continue;
          const {head, requested} = correction;
          const line = update.state.doc.lineAt(head);
          vim.sel.head = { line: line.number - 1, ch: head - line.from };
          visualHead = head;
          queueMicrotask(() => {
            const current = update.view.cm?.state?.vim;
            if (update.view.state.doc !== update.state.doc ||
                !update.view.state.selection.eq(update.state.selection) ||
                !current?.visualMode || current.visualLine || current.visualBlock) return;
            const currentLine = update.state.doc.line(current.sel.head.line + 1);
            if (currentLine.from + current.sel.head.ch !== requested) return;
            current.sel.head = {line: line.number - 1, ch: head - line.from};
          });
        }
      },
      destroy() {
        cursorObserver.disconnect();
        if (pendingFrame != null) cancelAnimationFrame(pendingFrame);
        if (adjustedCursor) {
          adjustedCursor.element.style.left = adjustedCursor.originalLeft;
          if (adjustedCursor.element.textContent === adjustedCursor.shownText)
            adjustedCursor.element.textContent = adjustedCursor.originalText;
        }
        if (view === editor) view = null;
      },
    };
  });
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
  return [revealed, decorations, insertionBoundary, visualSync, Prec.highest(EditorView.domEventHandlers({
    keydown(event, view) {
      pendingMotion = null;
      const vim = view.cm?.state?.vim;
      if ((event.key === 'd' || event.key === 'x') && !event.ctrlKey && !event.altKey && !event.metaKey &&
          !event.shiftKey && !view.composing && vim?.visualMode && !vim.insertMode &&
          !vim.visualLine && !vim.visualBlock && !vim.expectLiteralNext &&
          view.state.selection.ranges.length === 1 && !view.state.selection.main.empty &&
          visualHead != null) {
        const selection = view.state.selection.main;
        const pos = offset => {
          const line = view.state.doc.lineAt(offset);
          return {line: line.number - 1, ch: offset - line.from};
        };
        const forward = vim.sel.anchor.line < vim.sel.head.line ||
          (vim.sel.anchor.line === vim.sel.head.line && vim.sel.anchor.ch <= vim.sel.head.ch);
        vim.sel.anchor = pos(forward ? selection.from : step(view.state.doc, selection.to, false));
        vim.sel.head = pos(forward ? step(view.state.doc, selection.to, false) : selection.from);
      }
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
      if (!vim || vim.insertMode || vim.visualLine || vim.visualBlock || vim.inputState?.operator ||
          event.ctrlKey || event.altKey || event.metaKey || view.composing ||
          !['h', 'l', 'ArrowLeft', 'ArrowRight'].includes(event.key) ||
          view.state.selection.ranges.length !== 1 || (!vim.visualMode && !view.state.selection.main.empty)) return false;
      const forward = event.key === 'l' || event.key === 'ArrowRight';
      const buffered = vim.inputState?.keyBuffer?.join('') || '';
      if (vim.expectLiteralNext || (buffered && !/^\d+$/.test(buffered))) return false;
      const repeat = /^\d+$/.test(buffered) ? Number(buffered) : vim.inputState?.getRepeat?.() || 1;
      const doc = view.state.doc;
      const markers = currentMarkers(view);
      const visualLine = vim.visualMode ? doc.line(vim.sel.head.line + 1) : null;
      const start = vim.visualMode ? visualLine.from + Math.min(vim.sel.head.ch, visualLine.length)
        : view.state.selection.main.head;
      const line = doc.lineAt(start);
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
    if (pendingVisualChange && pendingVisualChange.operation === view?.cm?.curOp &&
        view.cm.state.vim?.insertMode && tr.selection?.ranges.length === 1 &&
        tr.selection.main.empty && tr.selection.main.head === pendingVisualChange.requestedHead) {
      return [tr, {selection: {anchor: pendingVisualChange.head}}];
    }
    if (!tr.selection && !tr.docChanged && !tr.effects.length) return tr;
    const rangesToReveal = revealedRanges(tr);
    const markers = hiddenMarkers(tr.newDoc, rangesToReveal);
    const boundary = insertionPosition(tr.startState.field(insertionBoundary, false) ?? null, tr);
    const block = isBlockCursor();
    const vim = view?.state === tr.startState ? view.cm?.state?.vim : null;
    const visual = !tr.docChanged && !view?.composing && view?.cm?.curOp?.isVimOp &&
      vim?.visualMode && !vim.insertMode && !vim.visualLine && !vim.visualBlock &&
      tr.selection && tr.selection.ranges.length === 1;
    let changed = false;
    let correctedVisualHead;
    const ranges = tr.newSelection.ranges.map((range, index) => {
      const previous = tr.startState.selection.ranges[index] || { head: range.anchor, anchor: range.anchor };
      if (visual) {
        const doc = tr.newDoc;
        const offset = pos => {
          const line = doc.line(pos.line + 1);
          return line.from + Math.min(pos.ch, line.length);
        };
        const requested = offset(vim.sel.head);
        const oldHead = visualHead ?? (previous.head - (previous.anchor < previous.head ? 1 : 0));
        const motion = pendingMotion;
        const target = motion && motion.state === tr.startState && requested === motion.rawHead
          ? motion.head : requested;
        const head = normalizePosition(doc, markers, target, oldHead, true, true);
        const anchor = offset(vim.sel.anchor);
        const selected = head === requested ? range : EditorSelection.range(
          Math.min(doc.lineAt(anchor).to, anchor + (head < anchor ? 1 : 0)),
          Math.min(doc.lineAt(head).to, head + (head >= anchor ? 1 : 0)));
        let { from, to } = selected;
        for (let pass = 0; pass <= markers.length; pass++) {
          const beforeFrom = from, beforeTo = to;
          for (const mark of markers) {
            if (!mark.opening || from > mark.to || to < mark.rangeTo - 2) continue;
            from = Math.min(from, mark.from);
            to = Math.max(to, mark.rangeTo);
          }
          if (from === beforeFrom && to === beforeTo) break;
        }
        changed = true;
        correctedVisualHead = {head, requested};
        return selected.anchor <= selected.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
      }
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
      ...(correctedVisualHead == null ? {} : { annotations: visualCursor.of(correctedVisualHead) }),
      sequential: true,
    }] : tr;
  })];
}

function buildDecorations(doc, markers = markersFor(doc)) {
  return Decoration.set(markers.map(({ from, to }) =>
    Decoration.replace({ inclusive: false }).range(from, to)), true);
}

module.exports = { createExtension, normalizePosition };
