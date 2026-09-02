// Receive: take a token that was pasted in, or wait on a wire for one.
//
// The question this screen exists to ask is the trust one. A token names its own issuer,
// so anyone who can reach a listening wallet could otherwise put their mint into it
// permanently just by paying us. On the command line that is a y/N prompt on stdin; here
// it is a modal that takes the keyboard, and — because a listening session hands tokens
// over one at a time through a callback — it has to be a modal the callback can *await*.
// Hence `ask()`: the handler stops on a promise, the user answers with a key, the promise
// resolves, and the token is claimed or refused.
import { h, text, column } from '../element.mjs'
import { useState, useInput, useMemo, useRef } from '../runtime.mjs'
import {
  Panel,
  Field,
  Button,
  Select,
  Status,
  Confirm,
  Hints,
  editText,
  moveSelection,
  moveFocus
} from '../components.mjs'
import { useTask } from '../hooks.mjs'
import { CLIPBOARD_READERS } from '../../clipboard.mjs'

const SOURCES = [
  { value: 'paste', label: 'paste a token', hint: 'type or paste it below' },
  { value: 'bluetooth', label: 'bluetooth', hint: 'listen for a neighbour' },
  { value: 'lan', label: 'local network', hint: 'listen on this wi-fi' },
  { value: 'dht', label: 'hyperdht', hint: 'listen on the hyperdht' }
]

// What each wire calls itself while it is up.
const LISTENING = {
  bluetooth: 'listening on bluetooth',
  lan: 'listening on the local network',
  dht: 'listening on the hyperdht'
}

// How much of the address the other side needs, and where they put it. Bluetooth and the
// local network both match on a prefix; the hyperdht dials the key itself, so it wants all
// of it.
const WANTED = {
  bluetooth: 'the sender needs this, or any prefix of it — give → bluetooth → their key',
  lan: 'the sender needs this, or any prefix of it — give → local network → their key',
  dht: 'the sender needs all of this — give → hyperdht → their key'
}

// The same arrow keys that walked the menu walk this list, and enter takes the source that
// is on it. What enter does next depends on whether the source has anything to fill in:
// pasting does, so it hands the keyboard to the token field and escape comes back to the
// list; listening does not, so it just starts, and there is no second step to stand in
// front of a screen with nothing on it to type.
const SOURCE = 'source'
const ENTRY = 'entry'

// The token field and the button under it. One field, but the shape is the same as the
// other forms: enter leaves the field, and only the button claims.
const SLOTS = 2
const BUTTON = 1

export function Receive({ api, onBack, onChanged, columns = 80 }) {
  const [stage, setStage] = useState(SOURCE)
  const [at, setAt] = useState(0)
  const [source, setSource] = useState(0)
  const [token, setToken] = useState('')
  const [taken, setTaken] = useState([])
  const [question, setQuestion] = useState(null)
  // What the last clipboard read had to say, when it had anything. Success needs no line —
  // the token turning up in the field below is the report.
  const [clip, setClip] = useState(null)
  // The address a sender has to be given to reach us. Only exists while a wire is up, and
  // on bluetooth not until the swarm has joined — so it arrives through a callback rather
  // than being something this screen can work out for itself.
  const [address, setAddress] = useState(null)
  const [copied, setCopied] = useState(null)
  const cancel = useRef(null)

  const wire = SOURCES[source].value

  // A question the caller waits on. Only one at a time, which is the right constraint: two
  // senders paying at once should not put two mint decisions on screen at once.
  const ask = (prompt, detail) => new Promise((resolve) => setQuestion({ prompt, detail, resolve }))

  // Claiming a token, whichever way it arrived. The trust check is in here rather than in
  // either caller, so a pasted token and a token off the radio are held to the same rule.
  const claim = async (tokenString, say) => {
    const parsed = api.inspect(tokenString)
    say(`receiving ${parsed.amount} ${parsed.unit} from ${parsed.mintUrl}`)

    if (!(await api.trusted(parsed.mintUrl))) {
      const detail = [
        'Receiving means trusting it: it holds the bitcoin backing this ecash,',
        'it can refuse to pay it out, and a later send may be funded from it.'
      ]
      // A mint reached over plaintext is one anyone on the path can read and rewrite,
      // which is worth more than the general warning above.
      if (parsed.mintUrl.startsWith('http://')) {
        detail.push('It is also reached over http, so the connection is neither private')
        detail.push('nor authentic.')
      }
      const yes = await ask(`${parsed.mintUrl} is a mint this wallet has never used.`, detail)
      setQuestion(null)
      if (!yes) throw new Error(`declined ${parsed.mintUrl} — nothing was received`)
      await api.trust(parsed.mintUrl)
    }

    await api.claim(tokenString)
    setTaken((previous) => [...previous, `${parsed.amount} ${parsed.unit} from ${parsed.mintUrl}`])
    return `${parsed.amount} ${parsed.unit} received`
  }

  const receive = useTask(
    async (input, { say }) => {
      if (wire === 'paste') return claim(input.trim(), say)

      const cancelled = new Promise((resolve) => {
        cancel.current = () => resolve(new Error('stopped listening'))
      })
      say(LISTENING[wire])
      // Stays listening: two senders at once, or one paying twice, should not need the
      // screen opened again. A token that is refused takes its own error, which must not
      // end the session for the next one.
      await api.listen({
        wire,
        cancelled,
        onaddress: setAddress,
        ontoken: async (received) => {
          try {
            await claim(received, say)
            say(LISTENING[wire])
          } catch (err) {
            say(`refused: ${err.message}`)
          }
        }
      })
      return taken.length ? `took ${taken.length}` : 'stopped listening'
    },
    {
      onDone: () => {
        // The wire is down, so the address is not one anybody can reach any more — and a
        // stale key left on screen is one somebody copies and sends into nowhere.
        setAddress(null)
        setCopied(null)
        onChanged()
      }
    }
  )

  useInput(
    (key) => {
      if (question) return // the modal has the keyboard
      if (receive.busy) {
        if (key.name === 'escape') cancel.current?.()
        if (key.input?.toLowerCase() === 'c' && address) {
          api.copy(address).then((copier) => setCopied(copier || 'nothing to copy with'))
        }
        return
      }
      if (stage === SOURCE) {
        if (key.name === 'escape') return onBack()
        if (key.name === 'return') {
          // Nothing to type on a wire, so nothing to open: enter is the whole gesture.
          if (wire !== 'paste') return receive.run('')
          setAt(0)
          return setStage(ENTRY)
        }
        setSource((at) => moveSelection(key, at, SOURCES.length))
        return
      }
      // Escape here changes the way in rather than leaving: the token typed so far is kept,
      // so a wrong turn costs one keystroke instead of a re-paste.
      if (key.name === 'escape') return setStage(SOURCE)
      // The terminal's own paste already works — it arrives as the characters themselves —
      // but it is Cmd-V on one platform and Ctrl-Shift-V on another, and neither is
      // something this screen can advertise. This one it can.
      if (key.name === 'ctrl-v' && wire === 'paste') {
        setClip('reading the clipboard…')
        api.paste().then(
          (text) => {
            if (text === null) {
              setClip(`no clipboard tool here — install one of ${CLIPBOARD_READERS}`)
            } else if (text === '') {
              setClip('the clipboard is empty')
            } else {
              setToken(text)
              setClip(null)
            }
          },
          (err) => setClip(`could not read the clipboard: ${err.message}`)
        )
        return
      }
      // Claiming is what the button is for; enter in the field only leaves the field.
      if (key.name === 'return' && at === BUTTON) {
        if (!token.trim()) return
        receive.run(token)
        return
      }
      const moved = moveFocus(key, at, SLOTS)
      if (moved !== at) return setAt(moved)
      if (key.name === 'return' || at === BUTTON) return
      setToken((previous) => editText(previous, key))
    },
    { active: !question }
  )

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: 'receive', focus: !receive.busy && !question },
      h(Select, { items: SOURCES, index: source, focus: stage === SOURCE && !receive.busy }),
      text(''),
      wire === 'paste'
        ? h(Field, {
            label: 'token',
            value: token,
            focus: stage === ENTRY && at === 0 && !receive.busy,
            placeholder: 'cashuB…'
          })
        : // A wire has no field, so this line stays blank and keeps the pane the same
          // height whichever source is on it. The status line below says what enter does.
          text(''),
      clip ? text(clip, { yellow: true }) : text(''),
      stage === ENTRY && !receive.busy
        ? h(Button, { label: 'claim it', focus: at === BUTTON, ready: token.trim() !== '' })
        : text(''),
      text(''),
      h(Status, {
        task: receive,
        idle:
          stage === SOURCE
            ? wire === 'paste'
              ? 'Enter opens the field to paste into'
              : 'Enter starts listening'
            : !token.trim()
              ? 'a token is needed — paste one above, or Ctrl-V'
              : at === BUTTON
                ? 'Enter claims it'
                : 'Enter moves on — the button below claims it',
        done: receive.result ?? 'received'
      })
    ),
    h(Hints, {
      columns,
      keys: question
        ? [
            ['y', 'trust and receive'],
            ['n', 'refuse']
          ]
        : receive.busy
          ? [address ? ['c', 'copy your address'] : null, ['esc', 'stop listening']]
          : stage === SOURCE
            ? [
                ['↑↓', 'pick a source'],
                ['enter', wire === 'paste' ? 'paste a token' : 'listen'],
                ['esc', 'go back']
              ]
            : // only pasting reaches this stage; the wires start on the enter above
              [
                ['ctrl-v', 'paste'],
                ['↑↓', 'move'],
                ['enter', at === BUTTON ? 'claim it' : 'move on'],
                ['esc', 'change source']
              ]
    }),
    address ? h(Address, { address, wire, copied, mode: api.addressMode() }) : null,
    question
      ? h(Confirm, {
          question: question.prompt,
          detail: [...question.detail, '', 'Trust this mint and receive this ecash?'],
          onAnswer: (yes) => question.resolve(yes)
        })
      : h(
          Panel,
          { title: `taken this session (${taken.length})`, focus: false, grow: 1 },
          ...(taken.length
            ? taken.map((line, index) => text(line, { key: index, green: true }))
            : [text('nothing yet', { dim: true })])
        )
  )
}

// Where a sender has to aim to reach this wallet. Shown only while a wire is actually up,
// because that is exactly as long as it is true — the hyperdht key is this run's own unless
// the wallet's address was asked for, and the bluetooth one belongs to the swarm.
//
// No QR. A cashu token and a bolt11 invoice are payloads other wallets know how to scan; a
// bare hex key is not one, and the other end of this is someone at a terminal typing it
// into `cashme give` or the give screen. Copying is the thing worth making easy.
function Address({ address, wire, copied, mode }) {
  return h(
    Panel,
    { title: 'your address', focus: true },
    text(address, { wrap: true, bold: true }),
    copied
      ? text(`copied to the clipboard (${copied})`, { green: true })
      : text(WANTED[wire], { dim: true }),
    // Whether this is worth keeping is the difference between the two modes, and the
    // person reading it out is the one who needs to know which they are handing over.
    mode === 'stable'
      ? text("this wallet's own address — the same every run, so the sender can keep it", {
          yellow: true
        })
      : text('for this run only — it is worth nothing to them afterwards', { dim: true })
  )
}
