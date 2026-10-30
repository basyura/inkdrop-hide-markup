const { EditorSelection, findClusterBreak } = require("@codemirror/state");

// 文字クラスタを一つ進むか戻り、行の境界では改行を越えた位置を返す。
function step(doc, pos, forward) {
  const line = doc.lineAt(pos);
  if (forward ? pos === line.to : pos === line.from) {
    return Math.max(0, Math.min(doc.length, pos + (forward ? 1 : -1)));
  }
  return line.from + findClusterBreak(line.text, pos - line.from, forward);
}

// 移動方向とカーソルの種類に応じて、非表示記号に重なる位置を補正する。
function normalizePosition(
  doc,
  markers,
  pos,
  oldPos,
  block,
  cursor,
  caretMove = false
) {
  const forward = pos >= oldPos;
  for (let pass = 0; pass <= markers.length; pass++) {
    const before = pos;
    for (const mark of markers) {
      if (mark.opening && !block && cursor && pos >= mark.from && pos <= mark.to) {
        pos =
          caretMove && forward && oldPos === mark.from && pos > mark.from
            ? step(doc, mark.to, true)
            : mark.from;
      } else if (mark.opening && pos >= mark.from && pos < mark.to) {
        pos =
          !forward && oldPos === mark.to && mark.from > doc.lineAt(mark.from).from
            ? step(doc, mark.from, false)
            : mark.to;
      } else if (
        !mark.opening &&
        !block &&
        cursor &&
        pos >= mark.from &&
        pos <= mark.to
      ) {
        pos =
          caretMove && !forward && oldPos === mark.to && pos < mark.to
            ? step(doc, mark.from, false)
            : mark.to;
      } else if (!mark.opening && pos >= mark.from && pos < mark.to) {
        if (block && cursor) {
          pos = forward ? mark.to : step(doc, mark.from, false);
        } else if (pos > mark.from) {
          pos = forward
            ? oldPos === mark.from
              ? step(doc, mark.to, true)
              : mark.to
            : mark.from;
        }
      } else if (
        !mark.opening &&
        !cursor &&
        pos === mark.to &&
        !block &&
        forward &&
        oldPos === mark.from
      ) {
        pos = step(doc, mark.to, true);
      } else if (
        !mark.opening &&
        !cursor &&
        pos === mark.to &&
        !block &&
        !forward &&
        oldPos > mark.to
      ) {
        pos = mark.from;
      }
    }
    if (
      block &&
      cursor &&
      pos === doc.lineAt(pos).to &&
      pos > doc.lineAt(pos).from
    ) {
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

// Vim の行番号・桁位置を、文書先頭からのオフセットへ変換する。
function vimOffset(doc, pos) {
  const line = doc.line(pos.line + 1);
  return line.from + Math.min(pos.ch, line.length);
}

// 文書先頭からのオフセットを、Vim の行番号・桁位置へ変換する。
function vimPosition(doc, offset) {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, ch: offset - line.from };
}

// Vim が行・矩形選択ではない文字単位の Visual モードか判定する。
function isCharacterVisual(vim) {
  return !!vim?.visualMode && !vim.insertMode && !vim.visualLine && !vim.visualBlock;
}

// Visual モードの移動先を補正し、本文全体を選択した構文の記号を範囲に含める。
function visualSelection({
  doc,
  range,
  anchor,
  requested,
  target,
  previousHead,
  markers,
}) {
  const head = normalizePosition(doc, markers, target, previousHead, true, true);
  let selected = range;
  if (head !== requested) {
    // Vim の末尾文字を含む位置を、CodeMirror の末尾位置を含まない選択へ変換する。
    const after = (pos) => Math.min(doc.lineAt(pos).to, pos + 1);
    selected =
      head < anchor
        ? EditorSelection.range(after(anchor), head)
        : EditorSelection.range(anchor, after(head));
  }
  let { from, to } = selected;
  // 内側の構文から広げると、その記号も外側の本文に含まれるため、一巡で範囲を確定できる。
  const openings = markers
    .filter((mark) => mark.opening)
    .sort((a, b) => a.rangeTo - a.rangeFrom - (b.rangeTo - b.rangeFrom));
  for (const mark of openings) {
    const contentEnd = mark.rangeTo - (mark.to - mark.from);
    if (from > mark.to || to < contentEnd) continue;
    from = Math.min(from, mark.from);
    to = Math.max(to, mark.rangeTo);
  }
  return {
    range:
      selected.anchor <= selected.head
        ? EditorSelection.range(from, to)
        : EditorSelection.range(to, from),
    head,
    requested,
  };
}

// 挿入境界や予約した移動先を考慮し、通常のカーソルと選択範囲の両端を補正する。
function standardSelection({
  tr,
  range,
  previous,
  markers,
  boundary,
  block,
  motion,
}) {
  const target = motion ? motion.head : range.head;
  const atInsertionBoundary =
    range.empty &&
    target === boundary &&
    markers.some((mark) => mark.opening && mark.from === boundary);
  let head = target;
  if (motion?.kind !== "append" && !atInsertionBoundary) {
    const oldHead = tr.changes.mapPos(previous.head);
    const caretMove =
      !tr.docChanged &&
      tr.isUserEvent("select") &&
      !tr.isUserEvent("select.pointer");
    head = normalizePosition(
      tr.newDoc,
      markers,
      target,
      oldHead,
      block,
      range.empty,
      caretMove
    );
  }
  const anchor = range.empty
    ? head
    : normalizePosition(
        tr.newDoc,
        markers,
        range.anchor,
        tr.changes.mapPos(previous.anchor),
        false,
        false
      );
  if (head === range.head && anchor === range.anchor) return range;
  return range.empty
    ? EditorSelection.cursor(head, range.assoc)
    : EditorSelection.range(anchor, head);
}

module.exports = {
  step,
  normalizePosition,
  vimOffset,
  vimPosition,
  isCharacterVisual,
  visualSelection,
  standardSelection,
};
