const { Annotation } = require("@codemirror/state");
const { ViewPlugin } = require("@codemirror/view");
const {
  step,
  normalizePosition,
  vimOffset,
  vimPosition,
  isCharacterVisual,
  visualSelection,
} = require("./selection");
const { createVisualCursor } = require("./visual-cursor");
const {
  canPrepareVisualDeletion,
  canReserveVimMotion,
} = require("./key-conditions");

// 拡張ごとに選択補正を管理する。移動予約は現在のキー処理中、変更予約は同じ Vim 操作中だけ保持する。
class VimSelection {
  // 選択補正の状態と、カーソル描画・更新処理を連携するビュープラグインを初期化する。
  constructor() {
    this.view = null;
    this.motion = null;
    this.visualHead = null;
    this.change = null;
    this.cursorCorrection = Annotation.define();
    // ビューに補正状態を結び付け、専用カーソルの更新と破棄を管理する。
    this.extension = ViewPlugin.define((view) => {
      this.view = view;
      const cursor = createVisualCursor(view, () => this.visualHead);
      return {
        // 選択状態を更新し、専用カーソルの再描画を予約する。
        update: (update) => {
          this.update(update);
          cursor.schedule();
        },
        // 専用カーソルを破棄し、このビューに属する予約と選択状態を解除する。
        destroy: () => {
          cursor.destroy();
          // 別のビューへ切り替わっている場合は、現在のビューの状態を解除しない。
          if (this.view !== view) {
            return;
          }
          this.clearMotion();
          this.visualHead = null;
          this.change = null;
          this.view = null;
        },
      };
    });
  }

  // 現在のキー操作に対して予約した移動先を破棄する。
  clearMotion() {
    this.motion = null;
  }

  // 現在のキー操作に限って移動先を予約し、処理後のマイクロタスクで解除する。
  reserveMotion(motion) {
    this.motion = motion;
    queueMicrotask(() => {
      // 後続の操作で予約が置き換わっていない場合だけ、今回の予約を解除する。
      if (this.motion === motion) {
        this.clearMotion();
      }
    });
  }

  // 同じ状態からの単一カーソル移動に適用できる予約を返す。
  motionFor(tr, range) {
    const motion = this.motion;
    // 予約がない・開始状態が異なる・文書変更がある・範囲選択の場合は適用しない。
    if (!motion || motion.state !== tr.startState || tr.docChanged || !range.empty) {
      return null;
    }
    // 末尾への挿入予約か、要求位置が Vim 本来の移動先と一致する場合に予約を返す。
    if (motion.kind === "append" || range.head === motion.rawHead) {
      return motion;
    }
    // 他のプラグインが指定した移動先は上書きしない。
    return null;
  }

  // このビューの Vim 操作による文字単位の Visual 選択を補正するか判定する。
  handlesSelection(tr) {
    const view = this.view;
    // 同じ状態からの選択変更で、文書変更や IME 変換を伴わない場合に限る。
    // Vim 操作中の文字単位 Visual モードで、明示された選択範囲が一つの場合に補正する。
    return (
      view?.state === tr.startState &&
      !tr.docChanged &&
      !view.composing &&
      !!view.cm?.curOp?.isVimOp &&
      isCharacterVisual(view.cm.state.vim) &&
      !!tr.selection &&
      tr.selection.ranges.length === 1
    );
  }

  // Vim 内部の選択位置と予約した移動先から、Visual 選択と論理上の移動先を補正する。
  correctSelection(tr, range, previous, markers) {
    const vim = this.view.cm.state.vim;
    const requested = vimOffset(tr.newDoc, vim.sel.head);
    const motion = this.motion;
    // 予約時と同じ状態で、要求位置が Vim 本来の移動先と一致する場合だけ予約を使う。
    const useMotion =
      motion?.state === tr.startState && requested === motion.rawHead;
    const target = useMotion ? motion.head : requested;
    // 補正済みの論理位置がなければ、前向き選択の末尾境界を一つ戻して直前の位置を求める。
    const previousHead =
      this.visualHead ?? previous.head - (previous.anchor < previous.head ? 1 : 0);
    return visualSelection({
      doc: tr.newDoc,
      range,
      anchor: vimOffset(tr.newDoc, vim.sel.anchor),
      requested,
      target,
      previousHead,
      markers,
    });
  }

  // d・x の直前に、Vim 内部の選択範囲へ非表示記号を含む削除範囲を反映する。
  prepareDeletion(event, view) {
    const vim = view.cm?.state?.vim;
    // Visual 削除の補正対象でないか、補正済みの論理カーソル位置がなければ処理しない。
    if (!canPrepareVisualDeletion(event, view, vim) || this.visualHead == null) {
      return;
    }
    const doc = view.state.doc;
    const selection = view.state.selection.main;
    const forward = vimOffset(doc, vim.sel.anchor) <= vimOffset(doc, vim.sel.head);
    const last = step(doc, selection.to, false);
    // d・x は CodeMirror の選択ではなく、末尾文字を含む Vim 内部の範囲を使う。
    vim.sel.anchor = vimPosition(doc, forward ? selection.from : last);
    vim.sel.head = vimPosition(doc, forward ? last : selection.from);
  }

  // Vim の左右移動で記号を飛び越える場合に、回数指定を反映した移動先を予約する。
  prepareMotion(event, view, markers) {
    const vim = view.cm?.state?.vim;
    // キー入力や Vim の状態が左右移動の予約対象でなければ処理しない。
    if (!canReserveVimMotion(event, view, vim)) {
      return;
    }
    const buffered = vim.inputState.keyBuffer.join("");
    const repeat = buffered ? Number(buffered) : vim.inputState.getRepeat() || 1;
    const forward = event.key === "l" || event.key === "ArrowRight";
    const doc = view.state.doc;
    const start = vim.visualMode
      ? vimOffset(doc, vim.sel.head)
      : view.state.selection.main.head;
    const line = doc.lineAt(start);
    let head = start;
    let skippedMarker = false;
    for (let i = 0; i < Math.min(repeat, line.length + 1); i++) {
      const stepped = step(doc, head, forward);
      const next = normalizePosition(doc, markers, stepped, head, true, true);
      // 移動先の補正で非表示記号を飛び越えた場合に、予約が必要な移動として記録する。
      if (
        next !== stepped &&
        markers.some((mark) => stepped >= mark.from && stepped < mark.to)
      ) {
        skippedMarker = true;
      }
      // 現在行の文字上から外れるか、それ以上進めない場合は移動を打ち切る。
      if (next < line.from || next >= line.to || next === head) {
        break;
      }
      head = next;
    }
    // 非表示記号を飛び越えていなければ、Vim 本来の移動に任せる。
    if (!skippedMarker) {
      return;
    }

    // Vim が計算する UTF-16 位置と一致する要求だけを置き換える。
    let rawHead = Math.max(
      line.from,
      Math.min(line.to - 1, start + (forward ? repeat : -repeat))
    );
    const code = doc.sliceString(rawHead, rawHead + 1).charCodeAt(0);
    // 下位サロゲート上なら、移動方向に合わせて文字の境界へ補正する。
    if (code >= 0xdc00 && code <= 0xdfff) {
      rawHead += rawHead < start ? -1 : 1;
      // 右への補正で行末に達した場合は、最後のサロゲートペアの先頭へ戻す。
      if (rawHead >= line.to) {
        rawHead -= 2;
      }
    }
    this.reserveMotion({
      state: view.state,
      head,
      rawHead,
      kind: "horizontal",
    });
  }

  // 編集後の変更予約を更新し、補正情報を Vim 内部のカーソル位置へ同期する。
  update(update) {
    const cm = update.view.cm;
    const vim = cm?.state?.vim;
    // 文書が変わったか、予約時の変更操作が終了した場合は予約を解除する。
    if (update.docChanged || this.change?.operation !== cm?.curOp) {
      this.change = null;
    }
    // 文書または選択が更新された場合は、前回の論理カーソル位置を解除する。
    if (update.docChanged || update.selectionSet) {
      this.visualHead = null;
    }
    // 文字単位の Visual モード以外は、以降の選択補正を行わない。
    if (!isCharacterVisual(vim)) {
      return;
    }
    // IME 変換中でなく、Vim の変更操作で文書が更新された場合に挿入位置を予約する。
    if (
      update.docChanged &&
      !update.view.composing &&
      cm.curOp?.isVimOp &&
      vim.lastEditInputState?.operator === "change"
    ) {
      // 開始記号まで広げた削除範囲の先頭を、同じ変更操作の挿入位置として記録する。
      for (const tr of update.transactions) {
        const selection = tr.startState.selection;
        // 単一の範囲選択以外は、変更後の挿入位置の予約対象にしない。
        if (selection.ranges.length !== 1 || selection.main.empty) {
          continue;
        }
        const doc = tr.startState.doc;
        const logicalFrom = Math.min(
          vimOffset(doc, vim.sel.anchor),
          vimOffset(doc, vim.sel.head)
        );
        // 選択の先頭が Vim 内部の先頭より前に広がっていなければ補正は不要。
        if (logicalFrom <= selection.main.from) {
          continue;
        }
        const changes = [];
        tr.changes.iterChanges((from, to, start, end, inserted) =>
          changes.push({ from, to, start, inserted })
        );
        // 変更箇所が一つの場合だけ、削除範囲と選択範囲を照合する。
        if (changes.length !== 1) {
          continue;
        }
        const change = changes[0];
        // 選択全体を削除し、文字を挿入していない変更だけを予約対象にする。
        if (
          change.from !== selection.main.from ||
          change.to !== selection.main.to ||
          change.inserted.length
        ) {
          continue;
        }
        const line = tr.newDoc.lineAt(change.start);
        this.change = {
          operation: cm.curOp,
          head: change.start,
          requestedHead:
            line.from +
            Math.min(logicalFrom - doc.lineAt(logicalFrom).from, line.length),
        };
      }
    }
    for (const tr of update.transactions) {
      const correction = tr.annotation(this.cursorCorrection);
      // カーソル位置の補正情報がない更新は同期対象にしない。
      if (!correction) {
        continue;
      }
      const { head, requested } = correction;
      const view = update.view;
      const position = vimPosition(update.state.doc, head);
      vim.sel.head = position;
      this.visualHead = head;
      // 後続処理が元の要求位置へ戻した場合だけ、同じ文書・選択に再適用する。
      queueMicrotask(() => {
        const currentVim = view.cm?.state?.vim;
        // ビュー・文書・選択が変わったか、文字単位の Visual モードを抜けた場合は中止する。
        if (
          this.view !== view ||
          view.state.doc !== update.state.doc ||
          !view.state.selection.eq(update.state.selection) ||
          !isCharacterVisual(currentVim)
        ) {
          return;
        }
        const currentLine = update.state.doc.line(currentVim.sel.head.line + 1);
        // Vim 内部のカーソルが元の要求位置へ戻された場合だけ再補正する。
        if (currentLine.from + currentVim.sel.head.ch !== requested) {
          return;
        }
        currentVim.sel.head = position;
      });
    }
  }

  // 同じ変更操作の挿入切り替えで、元の要求位置に代わる削除範囲の先頭を返す。
  changeCursor(tr) {
    const change = this.change;
    // 変更予約があり、現在も同じ変更操作が続いているか確認する。
    if (!change || change.operation !== this.view?.cm?.curOp) {
      return null;
    }
    // 挿入モードへ切り替わっているか確認する。
    if (!this.view.cm.state.vim?.insertMode) {
      return null;
    }

    const selection = tr.selection;
    // 明示された選択範囲が一つだけか確認する。
    if (selection?.ranges.length !== 1) {
      return null;
    }

    const cursor = selection.main;
    // 範囲選択ではなく、カーソルが元の要求位置にあるか確認する。
    if (!cursor.empty || cursor.head !== change.requestedHead) {
      return null;
    }

    return change.head;
  }
}

module.exports = { VimSelection };
