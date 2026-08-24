/**
 * Keyboard translation (src/ui/keys.ts) against the engine's authoritative
 * switch Moho::MAUI_KeycodeMSWToMaui @0x96abb0 and the WM_KEYDOWN char
 * classification (Cfile:1499783-1499824). No VM needed — pure function.
 *
 *   npx tsx scripts/verify-keys.ts
 */
import { translateKey } from '../src/ui/keys'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
type Mods = { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean }
const t = (code: string, key: string, mods: Mods = {}): ReturnType<typeof translateKey> =>
  translateKey({ code, key, shiftKey: false, ctrlKey: false, altKey: false, ...mods } as KeyboardEvent)

console.log('== VK -> maui keycode (MAUI_KeycodeMSWToMaui @0x96abb0) ==')
// OEM punctuation: cases 186..222 -> the unshifted ASCII code.
check(t('Semicolon', ';')?.wx === 59, 'Semicolon -> 59 (case 186)')
check(t('Equal', '=')?.wx === 43, 'Equal -> 43 (case 187)')
check(t('Comma', ',')?.wx === 44, 'Comma -> 44 (case 188)')
check(t('Minus', '-')?.wx === 45, 'Minus -> 45 (case 189)')
check(t('Period', '.')?.wx === 46, 'Period -> 46 (case 190)')
check(t('Slash', '/')?.wx === 47, 'Slash -> 47 (case 191)')
check(t('Backquote', '`')?.wx === 126, 'Backquote -> 126 (case 192) — the console toggle')
check(t('BracketLeft', '[')?.wx === 91, 'BracketLeft -> 91 (case 219)')
check(t('Backslash', '\\')?.wx === 92, 'Backslash -> 92 (case 220)')
check(t('BracketRight', ']')?.wx === 93, 'BracketRight -> 93 (case 221)')
check(t('Quote', "'")?.wx === 39, 'Quote -> 39 (case 222)')
// Alt is WXK_MENU 309, not WXK_ALT 307 (case 18 -> 309).
check(t('AltLeft', 'Alt')?.wx === 309, 'Alt -> 309 (WXK_MENU, case 18), not 307')
// PrintScreen has NO case 0x2c -> raw-VK fallback (44).
check(t('PrintScreen', 'PrintScreen')?.wx === 44, 'PrintScreen -> raw VK 44 (no case 0x2c)')
// Numpad operators: this engine uses 391-396, not wx 336-341.
check(t('NumpadMultiply', '*')?.wx === 391, 'Numpad * -> 391 (case 106)')
check(t('NumpadAdd', '+')?.wx === 392, 'Numpad + -> 392 (case 107)')
check(t('NumpadSubtract', '-')?.wx === 394, 'Numpad - -> 394 (case 109)')
check(t('NumpadDecimal', '.')?.wx === 395, 'Numpad . -> 395 (case 110)')
check(t('NumpadDivide', '/')?.wx === 396, 'Numpad / -> 396 (case 111)')
// Unchanged, still correct via fallback / existing entries.
check(t('KeyM', 'm')?.vk === 0x4d && t('KeyM', 'm')?.wx === 0x4d, 'Letter M -> VK/wx 0x4d (raw fallback)')
check(t('F1', 'F1')?.wx === 342, 'F1 -> 342 (case 112)')
check(t('Delete', 'Delete')?.wx === 127, 'Delete -> 127 (case 46)')

console.log('\n== char event (WM_KEYDOWN inited=0 -> real ASCII; default -> maui code) ==')
check(t('Semicolon', ';')?.charCode === 59, "';' char -> 59 (WM_CHAR ASCII)")
check(t('Semicolon', ':', { shiftKey: true })?.charCode === 58, "Shift+';' char -> 58 (shifted ASCII, NOT maui 59)")
check(t('NumpadMultiply', '*')?.charCode === 42, "Numpad * char -> 42 (ASCII, inited=0)")
check(t('NumpadDecimal', '.')?.charCode === 395, 'NumpadDecimal char -> 395 (maui code, default path, NOT inited=0)')
check(t('AltLeft', 'Alt')?.charCode === null, 'Alt char -> null (inited=1, no WM_CHAR)')
check(t('KeyC', 'c', { ctrlKey: true })?.charCode === 3, 'Ctrl+C char -> control code 3')
check(t('Enter', 'Enter')?.charCode === 13, 'Enter char -> 13')

console.log(failures === 0 ? '\nKEYS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
