const { Annotation } = require("@codemirror/state");
const { ViewPlugin } = require("@codemirror/view");
const {
  step, normalizePosition, vimOffset, vimPosition, isCharacterVisual, visualSelection,
} = require("./selection");
const { createVisualCursor } = require("./visual-cursor");
const { canPrepareVisualDeletion, canReserveVimMotion } = require("./key-conditions");

function singleSelection(state) {
  return state.selection.ranges.length === 1;
}

// One coordinator per extension. Motion reservations last for the current key;
// change reservations last only for the Vim operation that deleted the range.
class VimSelection {
  constructor() {
    this.view = null;
    this.motion = null;
    this.visualHead = null;
    this.change = null;
    this.cursorCorrection = Annotation.define();
    this.extension = ViewPlugin.define(view => {
      this.view = view;
      const cursor = createVisualCursor(view, () => this.visualHead);
      return {
        update: update => {
          this.update(update);
          cursor.schedule();
        },
        destroy: () => {
          cursor.destroy();
          if (this.view !== view) return;
          this.clearMotion();
          this.visualHead = null;
          this.change = null;
          this.view = null;
        },
      };
    });
  }

  clearMotion() {
    this.motion = null;
  }

  reserveMotion(motion) {
    this.motion = motion;
    queueMicrotask(() => {
      if (this.motion === motion) this.clearMotion();
    });
  }

  motionFor(tr, range) {
    const motion = this.motion;
    if (!motion || motion.state !== tr.startState || tr.docChanged || !range.empty) return null;
    if (motion.kind === 'append' || range.head === motion.rawHead) return motion;
    // Another plugin has already supplied its own target.
    return null;
  }

  handlesSelection(tr) {
    const view = this.view;
    return view?.state === tr.startState && !tr.docChanged && !view.composing &&
      !!view.cm?.curOp?.isVimOp && isCharacterVisual(view.cm.state.vim) &&
      !!tr.selection && tr.selection.ranges.length === 1;
  }

  correctSelection(tr, range, previous, markers) {
    const vim = this.view.cm.state.vim;
    const requested = vimOffset(tr.newDoc, vim.sel.head);
    const motion = this.motion;
    const useMotion = motion?.state === tr.startState && requested === motion.rawHead;
    const target = useMotion ? motion.head : requested;
    const previousHead = this.visualHead ?? (previous.head - (previous.anchor < previous.head ? 1 : 0));
    return visualSelection({doc: tr.newDoc, range, anchor: vimOffset(tr.newDoc, vim.sel.anchor),
      requested, target, previousHead, markers});
  }

  prepareDeletion(event, view) {
    const vim = view.cm?.state?.vim;
    if (!canPrepareVisualDeletion(event, view, vim) || this.visualHead == null) return;
    const doc = view.state.doc;
    const selection = view.state.selection.main;
    const forward = vimOffset(doc, vim.sel.anchor) <= vimOffset(doc, vim.sel.head);
    const last = step(doc, selection.to, false);
    // delete uses Vim's inclusive range, unlike yank/change which read the
    // CodeMirror selection. Give it the expanded range immediately before d/x.
    vim.sel.anchor = vimPosition(doc, forward ? selection.from : last);
    vim.sel.head = vimPosition(doc, forward ? last : selection.from);
  }

  prepareMotion(event, view, markers) {
    const vim = view.cm?.state?.vim;
    if (!canReserveVimMotion(event, view, vim)) return;
    const buffered = vim.inputState?.keyBuffer?.join('') || '';
    const repeat = buffered ? Number(buffered) : vim.inputState?.getRepeat?.() || 1;
    const forward = event.key === 'l' || event.key === 'ArrowRight';
    const doc = view.state.doc;
    const start = vim.visualMode ? vimOffset(doc, vim.sel.head) : view.state.selection.main.head;
    const head = visibleMotion(doc, markers, start, forward, repeat);
    if (head == null) return;
    this.reserveMotion({state: view.state, head, rawHead: rawMotion(doc, start, forward, repeat), kind: 'horizontal'});
  }

  update(update) {
    const cm = update.view.cm;
    const vim = cm?.state?.vim;
    if (update.docChanged || this.change?.operation !== cm?.curOp) this.change = null;
    if (update.docChanged && !update.view.composing && cm?.curOp?.isVimOp &&
        isCharacterVisual(vim) && vim.lastEditInputState?.operator === 'change') {
      this.change = captureChange(update, vim, cm.curOp);
    }
    if (update.docChanged || update.selectionSet) this.visualHead = null;
    if (!isCharacterVisual(vim)) return;
    for (const tr of update.transactions) {
      const correction = tr.annotation(this.cursorCorrection);
      if (correction) this.synchronizeHead(update, correction);
    }
  }

  synchronizeHead(update, {head, requested}) {
    const view = update.view;
    const position = vimPosition(update.state.doc, head);
    view.cm.state.vim.sel.head = position;
    this.visualHead = head;
    // A later listener may restore the uncorrected Vim target. Reapply only
    // while the document/selection still match and that exact target remains.
    queueMicrotask(() => {
      const vim = view.cm?.state?.vim;
      if (this.view !== view || view.state.doc !== update.state.doc ||
          !view.state.selection.eq(update.state.selection) || !isCharacterVisual(vim)) return;
      const currentLine = update.state.doc.line(vim.sel.head.line + 1);
      if (currentLine.from + vim.sel.head.ch !== requested) return;
      vim.sel.head = position;
    });
  }

  changeCursor(tr) {
    const change = this.change;
    if (!change || change.operation !== this.view?.cm?.curOp || !this.view.cm.state.vim?.insertMode ||
        tr.selection?.ranges.length !== 1 || !tr.selection.main.empty ||
        tr.selection.main.head !== change.requestedHead) return null;
    return change.head;
  }
}

function visibleMotion(doc, markers, start, forward, repeat) {
  const line = doc.lineAt(start);
  let head = start;
  let skippedMarker = false;
  for (let i = 0; i < Math.min(repeat, line.length + 1); i++) {
    const stepped = step(doc, head, forward);
    const next = normalizePosition(doc, markers, stepped, head, true, true);
    if (next !== stepped && markers.some(mark => stepped >= mark.from && stepped < mark.to)) {
      skippedMarker = true;
    }
    if (next < line.from || next >= line.to || next === head) break;
    head = next;
  }
  return skippedMarker ? head : null;
}

function rawMotion(doc, start, forward, repeat) {
  // Match Vim's uncorrected UTF-16 target, including surrogate-pair clipping.
  // We replace only this target, preserving other plugins' motion corrections.
  const line = doc.lineAt(start);
  let head = Math.max(line.from, Math.min(line.to - 1, start + (forward ? repeat : -repeat)));
  const code = doc.sliceString(head, head + 1).charCodeAt(0);
  if (code >= 0xDC00 && code <= 0xDFFF) {
    head += head < start ? -1 : 1;
    if (head >= line.to) head -= 2;
  }
  return head;
}

function captureChange(update, vim, operation) {
  // change deletes the CodeMirror range, then enters insert mode at the old
  // logical Vim start. Redirect that subsequent cursor request to the actual
  // deletion start when opening delimiters expanded the selection to the left.
  let pending = null;
  for (const tr of update.transactions) {
    const selection = tr.startState.selection;
    if (!singleSelection(tr.startState) || selection.main.empty) continue;
    const doc = tr.startState.doc;
    const logicalFrom = Math.min(vimOffset(doc, vim.sel.anchor), vimOffset(doc, vim.sel.head));
    if (logicalFrom <= selection.main.from) continue;
    const changes = [];
    tr.changes.iterChanges((from, to, start, end, inserted) => changes.push({from, to, start, inserted}));
    if (changes.length !== 1) continue;
    const change = changes[0];
    if (change.from !== selection.main.from || change.to !== selection.main.to || change.inserted.length) continue;
    const line = tr.newDoc.lineAt(change.start);
    pending = {operation, head: change.start,
      requestedHead: line.from + Math.min(logicalFrom - doc.lineAt(logicalFrom).from, line.length)};
  }
  return pending;
}

module.exports = { VimSelection };
