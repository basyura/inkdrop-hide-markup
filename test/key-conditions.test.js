import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorSelection } from "@codemirror/state";
import {
  canNormalizeInsertionCursor,
  canHandleCaretArrow,
  canHandleMarkupReveal,
  canHandleVimInsertion,
  canPrepareVisualDeletion,
  canReserveVimMotion,
} from "../lib/key-conditions.js";

const cursor = EditorSelection.single(4);
const selected = EditorSelection.single(4, 6);
const multiple = EditorSelection.create([
  EditorSelection.cursor(1),
  EditorSelection.cursor(4),
]);
const normal = {
  insertMode: false,
  visualMode: false,
  inputState: { operator: null, keyBuffer: [] },
};
const inserting = { ...normal, insertMode: true };
const visual = { ...normal, visualMode: true };

function check(predicate, defaults, allowed, blocked) {
  function evaluate(overrides) {
    const options = { ...defaults, ...overrides };
    const event = {
      key: options.key,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      ...options.event,
    };
    const selection = options.selection || cursor;
    const view = { composing: !!options.composing, state: { selection } };
    return predicate(event, view, selection, options.vim);
  }
  for (const options of allowed)
    assert.equal(evaluate(options), true, JSON.stringify(options));
  for (const options of blocked)
    assert.equal(evaluate(options), false, JSON.stringify(options));
}

const commandModifiers = ["ctrlKey", "altKey", "metaKey"].map((key) => ({
  event: { [key]: true },
}));
const unmodifiedOnly = [...commandModifiers, { event: { shiftKey: true } }];
const cursorUnavailable = [
  { composing: true },
  { selection: selected },
  { selection: multiple },
];
const pendingVimInput = [
  { vim: { ...normal, expectLiteralNext: true } },
  { vim: { ...normal, inputState: { operator: "delete" } } },
];

test("記号の一時表示は単一カーソルの修飾なし Enter だけを処理する", () => {
  check(
    canHandleMarkupReveal,
    { key: "Enter" },
    [{}, { vim: normal }, { vim: inserting }],
    [{ key: "a" }, ...unmodifiedOnly, ...cursorUnavailable, ...pendingVimInput]
  );
});

test("挿入位置の補正は通常エディタと Vim 挿入モードの単一カーソルに適用する", () => {
  check(
    (event, view, selection, vim) =>
      canNormalizeInsertionCursor(view, selection, vim),
    {},
    [{}, { vim: inserting }],
    [{ vim: normal }, { vim: visual }, ...cursorUnavailable]
  );
});

test("挿入カーソルの左右移動では修飾キーと範囲選択を通常処理に委ねる", () => {
  check(
    (event, view, selection, vim) =>
      canHandleCaretArrow(event, canNormalizeInsertionCursor(view, selection, vim)),
    { key: "ArrowLeft" },
    [{}, { key: "ArrowRight", vim: inserting }],
    [
      { key: "Enter" },
      { vim: normal },
      { vim: visual },
      ...unmodifiedOnly,
      ...cursorUnavailable,
    ]
  );
});

test("Vim 挿入切り替えは回数指定と Shift I を許可し、入力途中のコマンドを除外する", () => {
  check(
    canHandleVimInsertion,
    { key: "i", vim: normal },
    [
      {},
      { key: "a" },
      { key: "I", event: { shiftKey: true } },
      { vim: { ...normal, inputState: { keyBuffer: ["2"] } } },
    ],
    [
      { key: "x" },
      { vim: null },
      { vim: inserting },
      { vim: visual },
      { vim: { ...normal, inputState: { keyBuffer: ["g"] } } },
      ...commandModifiers,
      ...cursorUnavailable,
      ...pendingVimInput,
    ]
  );
});

test("Visual 削除の位置合わせは文字単位の範囲選択での d と x に限定する", () => {
  check(
    (event, view, selection, vim) => canPrepareVisualDeletion(event, view, vim),
    { key: "d", vim: visual, selection: selected },
    [{}, { key: "x" }],
    [
      { key: "c" },
      { vim: null },
      { vim: normal },
      { vim: inserting },
      { vim: { ...visual, visualLine: true } },
      { vim: { ...visual, visualBlock: true } },
      { vim: { ...visual, expectLiteralNext: true } },
      { selection: cursor },
      { selection: multiple },
      { composing: true },
      ...unmodifiedOnly,
    ]
  );
});

test("Vim 左右移動の予約は通常・文字単位 Visual と数値の回数指定だけを対象にする", () => {
  check(
    (event, view, selection, vim) => canReserveVimMotion(event, view, vim),
    { key: "h", vim: normal },
    [
      {},
      { key: "l" },
      { key: "ArrowLeft" },
      { key: "ArrowRight" },
      { event: { shiftKey: true } },
      { vim: visual, selection: selected },
      { vim: { ...normal, inputState: { keyBuffer: ["1", "2"] } } },
    ],
    [
      { key: "j" },
      { vim: null },
      { vim: inserting },
      { selection: selected },
      { selection: multiple },
      { vim: { ...visual, visualLine: true } },
      { vim: { ...visual, visualBlock: true } },
      { vim: { ...normal, inputState: { keyBuffer: ["g"] } } },
      { composing: true },
      ...commandModifiers,
      ...pendingVimInput,
    ]
  );
});
