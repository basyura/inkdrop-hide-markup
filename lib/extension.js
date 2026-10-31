const {
  EditorState,
  EditorSelection,
  StateField,
  StateEffect,
  Prec,
} = require("@codemirror/state");
const { Decoration, EditorView } = require("@codemirror/view");
const { markersFor } = require("./markers");
const { step, normalizePosition, standardSelection } = require("./selection");
const { VimSelection } = require("./vim-selection");
const {
  canNormalizeInsertionCursor,
  canHandleCaretArrow,
  canHandleMarkupReveal,
  canHandleVimInsertion,
} = require("./key-conditions");

/*
 * 記号の非表示・一時表示と、カーソル・選択範囲の補正を行う拡張を生成する。
 */
function createExtension(isBlockCursor = () => false) {
  const vimSelection = new VimSelection();
  // 記号を一時表示する範囲を、トランザクションで選択補正と表示状態の更新へ伝える。
  const reveal = StateEffect.define();
  // 一時表示中の範囲をエディタの状態に保持し、編集やカーソル移動に合わせて更新する。
  const revealed = StateField.define({
    // 一時表示する範囲がない状態で開始する。
    create() {
      return [];
    },
    // 編集とカーソル移動に合わせて、一時表示する範囲を更新する。
    update(value, tr) {
      return revealedRanges(tr);
    },
  });
  /*
   * 一時表示の指定または編集後の位置と選択状態から、表示を維持する範囲を求める。
   */
  function revealedRanges(tr) {
    for (let index = tr.effects.length - 1; index >= 0; index--) {
      if (tr.effects[index].is(reveal)) {
        return tr.effects[index].value;
      }
    }
    return (tr.startState.field(revealed, false) || [])
      .map((range) => ({
        from: tr.changes.mapPos(range.from, -1),
        to: tr.changes.mapPos(range.to, 1),
      }))
      .filter((range) =>
        tr.newSelection.ranges.some(
          (selection) => selection.head >= range.from && selection.head < range.to
        )
      );
  }
  /*
   * 一時表示する範囲に含まれる記号を除き、非表示にする記号を返す。
   */
  function hiddenMarkers(doc, ranges) {
    return markersFor(doc).filter(
      (mark) =>
        !ranges.some((range) => mark.from >= range.from && mark.to <= range.to)
    );
  }
  /*
   * 現在の文書と一時表示の状態から、非表示にする記号を取得する。
   */
  function currentMarkers(view) {
    return hiddenMarkers(view.state.doc, view.state.field(revealed));
  }
  const insertBefore = StateEffect.define();
  const insertionBoundary = StateField.define({
    // 開始記号の手前に保持する挿入境界を未指定にする。
    create() {
      return null;
    },
    // 単一カーソルが開始記号の手前にある間だけ、挿入境界を保持する。
    update(value, tr) {
      value = insertionPosition(value, tr);
      return value != null &&
        tr.newSelection.ranges.length === 1 &&
        tr.newSelection.main.empty &&
        tr.newSelection.main.head === value &&
        markersFor(tr.newDoc).some((mark) => mark.opening && mark.from === value)
        ? value
        : null;
    },
  });
  /*
   * 編集による位置の移動と明示的な指定を反映し、開始記号の手前の挿入境界を求める。
   */
  function insertionPosition(value, tr) {
    if (value != null) {
      value = tr.changes.mapPos(value, 1);
    }
    for (const effect of tr.effects) {
      if (effect.is(insertBefore)) {
        value = effect.value;
      }
    }
    return value;
  }

  const decorations = StateField.define({
    // 初期文書の非表示記号に装飾を設定する。
    create(state) {
      return buildDecorations(state.doc);
    },
    // 文書・選択・一時表示が変わったときに、非表示記号の装飾を再計算する。
    update(value, tr) {
      return tr.docChanged ||
        tr.selection ||
        tr.effects.some((effect) => effect.is(reveal))
        ? buildDecorations(tr.newDoc, hiddenMarkers(tr.newDoc, revealedRanges(tr)))
        : value;
    },
    // 装飾を表示へ適用し、非表示範囲をカーソルが飛び越える単位として登録する。
    provide: (field) => [
      EditorView.decorations.from(field),
      EditorView.atomicRanges.of((view) => view.state.field(field)),
    ],
  });
  return [
    revealed,
    decorations,
    insertionBoundary,
    vimSelection.extension,
    Prec.highest(
      EditorView.domEventHandlers({
        // 記号境界での移動・挿入・一時表示を処理し、Vim の削除と左右移動を準備する。
        keydown(event, view) {
          vimSelection.clearMotion();
          const vim = view.cm?.state?.vim;
          vimSelection.prepareDeletion(event, view);
          const boundary = view.state.field(insertionBoundary);
          if (
            boundary != null &&
            ((vim && !vim.insertMode) || event.key === "Escape")
          ) {
            view.dispatch({ effects: insertBefore.of(null) });
          }
          let selection = view.state.selection;
          const insertionCursor = canNormalizeInsertionCursor(view, selection, vim);
          if (insertionCursor) {
            const mark = currentMarkers(view).find((mark) =>
              mark.opening
                ? mark.to === selection.main.head
                : mark.from === selection.main.head
            );
            if (mark) {
              view.dispatch({
                selection: { anchor: mark.opening ? mark.from : mark.to },
              });
              selection = view.state.selection;
            }
          }
          if (canHandleCaretArrow(event, insertionCursor)) {
            const forward = event.key === "ArrowRight";
            const mark = currentMarkers(view).find((mark) =>
              forward
                ? mark.opening && mark.from === selection.main.head
                : !mark.opening && mark.to === selection.main.head
            );
            if (mark) {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch({
                effects: insertBefore.of(null),
                selection: {
                  anchor: step(
                    view.state.doc,
                    forward ? mark.to : mark.from,
                    forward
                  ),
                },
              });
              return true;
            }
          }
          if (canHandleMarkupReveal(event, view, selection, vim)) {
            if (
              view.state
                .field(revealed)
                .some(
                  (range) =>
                    selection.main.head >= range.from &&
                    selection.main.head < range.to
                )
            ) {
              return false;
            }
            const markers = currentMarkers(view);
            const candidate = markers
              .filter(
                (mark) =>
                  mark.opening &&
                  selection.main.head >= (isBlockCursor() ? mark.to : mark.from) &&
                  selection.main.head <= mark.rangeTo - 2
              )
              .sort(
                (a, b) => a.rangeTo - a.rangeFrom - (b.rangeTo - b.rangeFrom)
              )[0];
            if (candidate) {
              event.preventDefault();
              event.stopPropagation();
              view.dispatch({
                effects: reveal.of([
                  ...view.state.field(revealed),
                  { from: candidate.rangeFrom, to: candidate.rangeTo },
                ]),
              });
              return true;
            }
          }
          if (canHandleVimInsertion(event, view, selection, vim)) {
            const line = view.state.doc.lineAt(selection.main.head);
            const firstNonWhitespace =
              line.from + Math.max(0, line.text.search(/\S/));
            if (event.key === "a") {
              const mark = currentMarkers(view).find(
                (mark) =>
                  !mark.opening &&
                  step(view.state.doc, selection.main.head, true) === mark.from
              );
              if (mark) {
                vimSelection.reserveMotion({
                  state: view.state,
                  head: mark.to,
                  kind: "append",
                });
              }
              return false;
            }
            const mark = currentMarkers(view).find(
              (mark) =>
                mark.opening &&
                (event.key === "I"
                  ? mark.from === firstNonWhitespace
                  : mark.to === selection.main.head)
            );
            if (mark) {
              view.dispatch({
                effects: insertBefore.of(mark.from),
                selection: { anchor: mark.from },
              });
            }
            return false;
          }
          vimSelection.prepareMotion(event, view, currentMarkers(view));
          return false;
        },
      })
    ),
    // 各選択範囲を補正し、一時表示範囲と Vim の論理上の移動先を更新する。
    EditorState.transactionFilter.of((tr) => {
      const changeCursor = vimSelection.changeCursor(tr);
      if (changeCursor != null) {
        return [tr, { selection: { anchor: changeCursor } }];
      }
      if (!tr.selection && !tr.docChanged && !tr.effects.length) {
        return tr;
      }
      const rangesToReveal = revealedRanges(tr);
      const markers = hiddenMarkers(tr.newDoc, rangesToReveal);
      const boundary = insertionPosition(
        tr.startState.field(insertionBoundary, false) ?? null,
        tr
      );
      const block = isBlockCursor();
      const visual = vimSelection.handlesSelection(tr);
      let changed = false;
      let correctedVisualHead;
      const ranges = tr.newSelection.ranges.map((range, index) => {
        const previous = tr.startState.selection.ranges[index] || {
          head: range.anchor,
          anchor: range.anchor,
        };
        if (visual) {
          const result = vimSelection.correctSelection(tr, range, previous, markers);
          changed = true;
          correctedVisualHead = {
            head: result.head,
            requested: result.requested,
          };
          return result.range;
        }
        const corrected = standardSelection({
          tr,
          range,
          previous,
          markers,
          boundary,
          block,
          motion: vimSelection.motionFor(tr, range),
        });
        if (corrected !== range) {
          changed = true;
        }
        return corrected;
      });
      const needsRevealEffect =
        (tr.startState.field(revealed, false) || []).length > 0 ||
        tr.effects.some((effect) => effect.is(reveal));
      return changed || needsRevealEffect
        ? [
            tr,
            {
              ...(changed
                ? {
                    selection: EditorSelection.create(
                      ranges,
                      tr.newSelection.mainIndex
                    ),
                  }
                : {}),
              ...(needsRevealEffect ? { effects: reveal.of(rangesToReveal) } : {}),
              ...(correctedVisualHead == null
                ? {}
                : {
                    annotations:
                      vimSelection.cursorCorrection.of(correctedVisualHead),
                  }),
              sequential: true,
            },
          ]
        : tr;
    }),
  ];
}

/*
 * 対象の記号を空の表示に置き換える装飾を生成する。
 */
function buildDecorations(doc, markers = markersFor(doc)) {
  return Decoration.set(
    markers.map(({ from, to }) =>
      Decoration.replace({ inclusive: false }).range(from, to)
    ),
    true
  );
}

module.exports = { createExtension, normalizePosition };
