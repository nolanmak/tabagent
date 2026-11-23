// Key definitions for CDP Input.dispatchKeyEvent.

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  location?: number;
}

const SPECIAL: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
};
for (let i = 1; i <= 12; i++) SPECIAL[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const ALIASES: Record<string, string> = {
  esc: "Escape",
  return: "Enter",
  del: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  option: "Alt",
  alt: "Alt",
  shift: "Shift",
  space: "Space",
  pgup: "PageUp",
  pgdn: "PageDown",
};

const SHIFTED: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};
const PUNCT_CODES: Record<string, [string, number]> = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220],
  ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
};

export function keyDef(name: string): KeyDef & { shift?: boolean } {
  const alias = ALIASES[name.toLowerCase()];
  const n = alias ?? name;
  if (SPECIAL[n]) return SPECIAL[n];
  if (n.length === 1) {
    const ch = n;
    if (/[a-z]/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
    if (/[A-Z]/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: true };
    if (/[0-9]/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    if (SHIFTED[ch]) {
      const base = SHIFTED[ch];
      const code = /[0-9]/.test(base) ? `Digit${base}` : PUNCT_CODES[base][0];
      const kc = /[0-9]/.test(base) ? base.charCodeAt(0) : PUNCT_CODES[base][1];
      return { key: ch, code, keyCode: kc, text: ch, shift: true };
    }
    if (PUNCT_CODES[ch]) return { key: ch, code: PUNCT_CODES[ch][0], keyCode: PUNCT_CODES[ch][1], text: ch };
    return { key: ch, code: "", keyCode: 0, text: ch };
  }
  throw new Error(`Unknown key "${name}"`);
}

export const MOD_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function parseChord(chord: string): { mods: string[]; key: string } {
  // "Control+Shift+K", "Meta+a", "+" alone, "Control++"
  if (chord === "+") return { mods: [], key: "+" };
  const parts = chord.split("+");
  let key = parts.pop()!;
  if (key === "" && parts.length) {
    parts.pop();
    key = "+";
  }
  const mods = parts.map((p) => ALIASES[p.toLowerCase()] ?? p).filter((m) => m in MOD_BITS);
  if (mods.length !== parts.length) throw new Error(`Unknown modifier in "${chord}". Use Alt, Control, Meta, Shift`);
  return { mods, key };
}

/** Editing commands Chrome needs for common shortcuts (esp. on macOS). */
export function editCommand(mods: string[], key: string): string[] | undefined {
  const primary = mods.includes("Meta") || mods.includes("Control");
  if (!primary || mods.includes("Alt")) return undefined;
  const k = key.toLowerCase();
  const map: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: mods.includes("Shift") ? "redo" : "undo" };
  return map[k] ? [map[k]] : undefined;
}
