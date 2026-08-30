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
  Select,
  Status,
  Confirm,
  Hints,
  editText,
  moveSelection
} from '../components.mjs'
import { useTask } from '../hooks.mjs'

const SOURCES = [
  { value: 'paste', label: 'paste a token', hint: 'type or paste it below' },
  { value: 'bluetooth', label: 'bluetooth', hint: 'listen for a neighbour' },
  { value: 'dht', label: 'hyperdht', hint: 'listen on the hyperdht' }
]

export function Receive({ api, onBack, onChanged }) {
  const [source, setSource] = useState(0)
  const [token, setToken] = useState('')
  const [taken, setTaken] = useState([])
  const [question, setQuestion] = useState(null)
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
      say(wire === 'dht' ? 'listening on the hyperdht' : 'listening on bluetooth')
      // Stays listening: two senders at once, or one paying twice, should not need the
      // screen opened again. A token that is refused takes its own error, which must not
      // end the session for the next one.
      await api.listen({
        dht: wire === 'dht',
        cancelled,
        ontoken: async (received) => {
          try {
            await claim(received, say)
            say(wire === 'dht' ? 'listening on the hyperdht' : 'listening on bluetooth')
          } catch (err) {
            say(`refused: ${err.message}`)
          }
        }
      })
      return taken.length ? `took ${taken.length}` : 'stopped listening'
    },
    { onDone: onChanged }
  )

  useInput(
    (key) => {
      if (question) return // the modal has the keyboard
      if (receive.busy) {
        if (key.name === 'escape') cancel.current?.()
        return
      }
      if (key.name === 'escape') return onBack()
      if (key.name === 'up' || key.name === 'down') {
        setSource((at) => moveSelection(key, at, SOURCES.length))
        return
      }
      if (key.name === 'return') {
        if (wire === 'paste' && !token.trim()) return
        receive.run(token)
        return
      }
      if (wire === 'paste') setToken((previous) => editText(previous, key))
    },
    { active: !question }
  )

  return column(
    { gap: 0, grow: 1 },
    h(
      Panel,
      { title: 'receive', focus: !receive.busy && !question },
      h(Select, { items: SOURCES, index: source, focus: !receive.busy }),
      text(''),
      wire === 'paste'
        ? h(Field, { label: 'token', value: token, focus: !receive.busy, placeholder: 'cashuB…' })
        : text('nothing to type — enter starts listening', { dim: true }),
      text(''),
      h(Status, {
        task: receive,
        idle: wire === 'paste' ? 'enter claims it' : 'enter starts listening',
        done: receive.result ?? 'received'
      })
    ),
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
        ),
    h(Hints, {
      keys: question
        ? [
            ['y', 'trust and receive'],
            ['n', 'refuse']
          ]
        : receive.busy
          ? [['esc', 'stop']]
          : [
              ['↑↓', 'source'],
              ['enter', wire === 'paste' ? 'claim' : 'listen'],
              ['esc', 'back']
            ]
    })
  )
}
