// Raw bytes from the terminal, turned into named keys.
//
// A terminal in raw mode hands over escape sequences, not events: an arrow is three bytes
// beginning ESC [, and a lone ESC is the Escape key only because nothing follows it in the
// same chunk. Decoding is per chunk for that reason — the sequence arrives whole.
const SEQUENCES = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[3~': 'delete',
  '\x1b[Z': 'shifttab',
  '\x1bOA': 'up',
  '\x1bOB': 'down',
  '\x1bOC': 'right',
  '\x1bOD': 'left'
}

const CONTROLS = {
  '\r': 'return',
  '\n': 'return',
  '\t': 'tab',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\x1b': 'escape',
  '\x03': 'ctrl-c',
  '\x04': 'ctrl-d',
  '\x0c': 'ctrl-l'
}

// One event per key: `{ name, input, ctrl }`. `input` is the character typed and is empty
// for anything that is not one, so a text field can append `input` without filtering out
// arrows itself.
export function decode(chunk) {
  const data = chunk.toString('utf8')
  const events = []

  // A paste arrives as one chunk of ordinary characters; a sequence arrives alone. So try
  // the whole chunk as a sequence first, and only then walk it character by character.
  if (SEQUENCES[data]) return [key(SEQUENCES[data])]
  if (CONTROLS[data]) return [key(CONTROLS[data], data)]

  for (let i = 0; i < data.length; i++) {
    const char = data[i]
    if (char === '\x1b') {
      const match = Object.keys(SEQUENCES).find((seq) => data.startsWith(seq, i))
      if (match) {
        events.push(key(SEQUENCES[match]))
        i += match.length - 1
        continue
      }
      events.push(key('escape', char))
      continue
    }
    if (CONTROLS[char]) {
      events.push(key(CONTROLS[char], char))
      continue
    }
    // Remaining C0 codes are ctrl-<letter>: 0x01 is ctrl-a, and so on up.
    const code = char.charCodeAt(0)
    if (code < 0x20) {
      events.push({ name: `ctrl-${String.fromCharCode(code + 96)}`, input: '', ctrl: true })
      continue
    }
    events.push(key(char, char))
  }
  return events
}

function key(name, input = '') {
  return {
    name,
    input: input === '\x1b' || input < ' ' ? '' : input,
    ctrl: name.startsWith('ctrl-')
  }
}
