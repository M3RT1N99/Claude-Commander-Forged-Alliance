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
 * Windows-VK → maui-KeyCode. This is `Moho::MAUI_KeycodeMSWToMaui` @0x96abb0
 * VERBATIM (a switch; every entry below is a `case`): letters/digits and any VK
 * with no case fall through to the raw VK, exactly as the engine's caller does
 * (`v4 = wxCharCodeMSWToWX(vk); if(!v4) v4 = raw vk`, Cfile:1499467-1499469).
 * WXK-Enum ab 300: START=300 … PAUSE=310 (uiutil.lua:81 anchor) … SCROLL=367;
 * this engine uses NON-standard 391-396 for the numpad operators.
 */
const VK_TO_WX: Record<number, number> = {
  0x03: 303 /* CANCEL */, 0x0c: 305 /* CLEAR */,
  0x10: 306 /* SHIFT */, 0x11: 308 /* CONTROL */, 0x12: 309 /* MENU — VK_MENU->WXK_MENU (case 18->309), NOT 307 */,
  0x13: 310 /* PAUSE */, 0x14: 311 /* CAPITAL */,
  0x21: 312 /* PRIOR */, 0x22: 313 /* NEXT */, 0x23: 314 /* END */,
  0x24: 315 /* HOME */, 0x25: 316 /* LEFT */, 0x26: 317 /* UP */,
  0x27: 318 /* RIGHT */, 0x28: 319 /* DOWN */, 0x29: 320 /* SELECT */,
  0x2a: 321 /* PRINT */, 0x2b: 322 /* EXECUTE */,
  // 0x2c (SNAPSHOT/PrintScreen) has NO case in the switch -> raw-VK fallback (44).
  0x2d: 324 /* INSERT (case 45) */, 0x2e: 127 /* DELETE (case 46->127) */, 0x2f: 325 /* HELP */,
  // Numpad operators: this engine maps them to 391-396, not wx's usual 336-341.
  0x6a: 391 /* MULTIPLY */, 0x6b: 392 /* ADD */, 0x6d: 394 /* SUBTRACT */,
  0x6e: 395 /* DECIMAL */, 0x6f: 396 /* DIVIDE */,
  0x90: 366 /* NUMLOCK */, 0x91: 367 /* SCROLL */,
  // OEM punctuation -> the unshifted ASCII code (cases 186..222). Without these
  // the console toggle key (backquote, 0xC0->126) and every punctuation hotkey
  // fell back to the raw VK (186,187,…) — the wrong maui keycode.
  0xba: 59 /* ; */, 0xbb: 43 /* = */, 0xbc: 44 /* , */, 0xbd: 45 /* - */,
  0xbe: 46 /* . */, 0xbf: 47 /* / */, 0xc0: 126 /* ` */, 0xdb: 91 /* [ */,
  0xdc: 92 /* \ */, 0xdd: 93 /* ] */, 0xde: 39 /* ' */,
}
for (let i = 0; i < 10; i++) VK_TO_WX[0x60 + i] = 326 + i // NUMPAD0-9
for (let i = 0; i < 24; i++) VK_TO_WX[0x70 + i] = 342 + i // F1-F24

/**
 * The WM_KEYDOWN `inited = 0` cases (Cfile:1499785-1499805): these keys take
 * their char from the REAL WM_CHAR (the shifted ASCII character), not from an
 * immediate maui-keycode char. Everything else in VK_TO_WX takes the maui code
 * as its char (the `default` HandleChar path, Cfile:1499822). Only the members
 * that ALSO sit in VK_TO_WX matter here (space/back/tab/enter/esc are handled by
 * the printable + explicit branches below).
 */
const CHAR_FROM_WM_CHAR = new Set([
  0x6a, 0x6b, 0x6d, 0x6f, // numpad * + - /  (0x6e Decimal is NOT here -> maui char)
  0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xdb, 0xdc, 0xdd, 0xde, // OEM punctuation
])

export interface FaKeyEvent {
  /** Windows-VK (RawKeyCode des Events). */
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

/** Übersetzt ein Browser-KeyboardEvent in die Engine-Kodierung. */
export function translateKey(e: KeyboardEvent): FaKeyEvent | null {
  const vk = CODE_TO_VK[e.code]
  if (vk === undefined) return null

  // wx-KeyCode: Spezialtabelle, sonst wParam (VK) — für Buchstaben/Ziffern
  // ist das der Großbuchstaben-ASCII.
  const wx = VK_TO_WX[vk] ?? vk

  // Char-Synthese (wx 2.4): Modifier-/Lock-Tasten liefern KEIN Char
  // (Cfile:1499812-1499818); Spezialtasten das wx-codierte Char
  // (Cfile:1499822); druckbare das echte Zeichen (Browser übersetzt Shift),
  // Ctrl+Buchstabe das Steuerzeichen (HandleChar isASCII, Ctrl+C=3).
  let charCode: number | null = null
  if (vk === 0x10 || vk === 0x11 || vk === 0x12 || vk === 0x14 || vk === 0x90 || vk === 0x91) {
    // inited = 1 (Cfile:1499807-1499814): modifier/lock keys fire no char.
    charCode = null
  } else if (VK_TO_WX[vk] !== undefined && vk !== 0x2e && !CHAR_FROM_WM_CHAR.has(vk)) {
    // default HandleChar path (Cfile:1499822): the maui keycode IS the char
    // (nav keys, F-keys, NumpadDecimal 0x6e -> 395, …).
    charCode = wx
  } else if (vk === 0x2e) {
    charCode = 127 // WXK_DELETE
  } else if (e.key.length === 1) {
    // Printable + the inited=0 keys (numpad * + - /, OEM punctuation): the char
    // is the REAL shifted WM_CHAR, which the browser already resolved in e.key
    // (so ':' from Shift+; gives 58, not the maui code 59).
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
