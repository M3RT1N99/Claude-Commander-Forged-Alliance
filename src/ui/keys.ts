/**
 * Tastatur-Übersetzung Browser → FA-Engine.
 *
 * Die Engine bekommt jedes Tasten-Event zweimal kodiert (wxWidgets 2.4,
 * wxWndProc @0x96D090):
 *   RawKeyCode = Windows-VK (wParam des WM_KEYDOWN; CreateKeyEvent
 *                Cfile:1499375-1499404 legt ihn in m_rawCode)
 *   KeyCode    = wx-Code (wxCharCodeMSWToWX): Buchstaben/Ziffern als
 *                Großbuchstaben-ASCII, Spezialtasten ≥ 300 (WXK_*-Enum,
 *                Anker: uiutil.lua:81 `UIUtil.VK_PAUSE = 310` = WXK_PAUSE)
 *
 * Beide Tabellen hier sind exakt diese Kodierungen — keine eigenen Nummern.
 */

/** Browser `KeyboardEvent.code` → Windows-VK (RawKeyCode). */
const CODE_TO_VK: Record<string, number> = {
  Backspace: 0x08, Tab: 0x09, Clear: 0x0c, Enter: 0x0d, NumpadEnter: 0x0d,
  ShiftLeft: 0x10, ShiftRight: 0x10, ControlLeft: 0x11, ControlRight: 0x11,
  AltLeft: 0x12, AltRight: 0x12, Pause: 0x13, CapsLock: 0x14, Escape: 0x1b,
  Space: 0x20, PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  PrintScreen: 0x2c, Insert: 0x2d, Delete: 0x2e,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  NumLock: 0x90, ScrollLock: 0x91,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe,
  Slash: 0xbf, Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc,
  BracketRight: 0xdd, Quote: 0xde,
}
for (let i = 0; i < 26; i++) CODE_TO_VK[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i
for (let i = 0; i < 10; i++) {
  CODE_TO_VK[`Digit${i}`] = 0x30 + i
  CODE_TO_VK[`Numpad${i}`] = 0x60 + i
}
for (let i = 1; i <= 24; i++) CODE_TO_VK[`F${i}`] = 0x70 + (i - 1)

/**
 * Windows-VK → wx-2.4-KeyCode (wxCharCodeMSWToWX): nur die Spezialtasten
 * werden übersetzt; Buchstaben/Ziffern/OEM reicht wx als wParam durch.
 * WXK-Enum ab 300: START=300 … PAUSE=310 (der uiutil-Anker) … SCROLL=367.
 */
const VK_TO_WX: Record<number, number> = {
  0x03: 303 /* CANCEL */, 0x0c: 305 /* CLEAR */,
  0x10: 306 /* SHIFT */, 0x11: 308 /* CONTROL */, 0x12: 307 /* ALT */,
  0x13: 310 /* PAUSE */, 0x14: 311 /* CAPITAL */,
  0x21: 312 /* PRIOR */, 0x22: 313 /* NEXT */, 0x23: 314 /* END */,
  0x24: 315 /* HOME */, 0x25: 316 /* LEFT */, 0x26: 317 /* UP */,
  0x27: 318 /* RIGHT */, 0x28: 319 /* DOWN */, 0x29: 320 /* SELECT */,
  0x2a: 321 /* PRINT */, 0x2b: 322 /* EXECUTE */, 0x2c: 323 /* SNAPSHOT */,
  0x2d: 324 /* INSERT */, 0x2e: 127 /* DELETE */, 0x2f: 325 /* HELP */,
  0x6a: 336 /* MULTIPLY */, 0x6b: 337 /* ADD */, 0x6d: 339 /* SUBTRACT */,
  0x6e: 340 /* DECIMAL */, 0x6f: 341 /* DIVIDE */,
  0x90: 366 /* NUMLOCK */, 0x91: 367 /* SCROLL */,
}
for (let i = 0; i < 10; i++) VK_TO_WX[0x60 + i] = 326 + i // NUMPAD0-9
for (let i = 0; i < 24; i++) VK_TO_WX[0x70 + i] = 342 + i // F1-F24

export interface FaKeyEvent {
  /** Windows VK (RawKeyCode of the event). */
  vk: number
  /** wx/maui-KeyCode (Buchstaben = Groß-ASCII, Spezialtasten ≥ 300). */
  wx: number
  /**
   * Das synthetische Char-Event nach einem nicht konsumierten KeyDown
   * (MSWWindowProc Cfile:1499784-1499824): druckbare Zeichen als Zeichencode
   * (Ctrl+Buchstabe = Steuerzeichen 1-26, wie WM_CHAR), Spezialtasten als
   * wx-Code, Modifier-Tasten GAR NICHT (null).
   */
  charCode: number | null
}

/** Translates a browser KeyboardEvent into engine encoding. */
export function translateKey(e: KeyboardEvent): FaKeyEvent | null {
  const vk = CODE_TO_VK[e.code]
  if (vk === undefined) return null

  // wx-KeyCode: special table, otherwise wParam (VK) — for letters/numbers
  // is this the uppercase ASCII.
  const wx = VK_TO_WX[vk] ?? vk

  // Char synthesis (wx 2.4): Modifier/Lock keys do NOT provide a char
  // (Cfile:1499812-1499818); Special keys the wx-coded character
  // (Cfile:1499822); printable the real character (browser translates shift),
  // Ctrl+Letter the control character (HandleChar isASCII, Ctrl+C=3).
  let charCode: number | null = null
  if (vk === 0x10 || vk === 0x11 || vk === 0x12 || vk === 0x14 || vk === 0x90 || vk === 0x91) {
    charCode = null
  } else if (VK_TO_WX[vk] !== undefined && vk !== 0x2e) {
    charCode = wx
  } else if (vk === 0x2e) {
    charCode = 127 // WXK_DELETE
  } else if (e.key.length === 1) {
    const c = e.key.charCodeAt(0)
    charCode = e.ctrlKey && c >= 0x40 ? c & 31 : c
  } else if (vk === 0x0d) {
    charCode = 13
  } else if (vk === 0x1b) {
    charCode = 27
  } else if (vk === 0x08) {
    charCode = 8
  } else if (vk === 0x09) {
    charCode = 9
  }
  return { vk, wx, charCode }
}
