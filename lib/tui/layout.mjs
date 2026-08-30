// Element tree in, terminal lines out. Every function here takes a column budget and
// returns lines already padded to it, so a caller can stack or zip them without measuring
// again.
//
// The layout is flexbox as far as one axis and one flag: children size to their content,
// and `grow` shares out whatever is left. That covers a header bar, a sidebar beside a
// list, and a footer pinned to the bottom, which is the whole of what these screens ask
// for. There is no wrapping, no shrink factor and no absolute positioning on purpose —
// each would be another thing to reason about when a box comes out one column wrong.
import { pad, width, wrap, cut, style } from './style.mjs'

const BORDERS = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' }
}

// The padding shorthand a box takes: a number for all four sides, or an object naming the
// ones that differ.
function padding(value) {
  if (typeof value === 'number') return { top: value, right: value, bottom: value, left: value }
  return { top: 0, right: 0, bottom: 0, left: 0, ...(value || {}) }
}

// How wide this node wants to be, given no constraint. Rows need it to know what is left
// over for their growing children, and nothing else does.
export function measure(node) {
  if (node === null || node === undefined || node === false) return 0
  if (typeof node === 'string' || typeof node === 'number') return width(String(node))

  const props = node.props || {}
  if (typeof props.width === 'number') return props.width

  switch (node.type) {
    case 'text': {
      const value = node.children.map(String).join('')
      return Math.max(0, ...value.split('\n').map(width))
    }
    case 'spacer':
      return 0
    case 'row': {
      const gap = (props.gap || 0) * Math.max(0, node.children.length - 1)
      return node.children.reduce((total, child) => total + measure(child), gap)
    }
    case 'column':
      return Math.max(0, ...node.children.map(measure))
    case 'box': {
      const inner = Math.max(0, ...node.children.map(measure))
      const inset = padding(props.padding)
      const border = props.border === false ? 0 : 2
      return inner + inset.left + inset.right + border
    }
    default:
      return 0
  }
}

// Lines for this node inside `columns`, each exactly that wide. Height is whatever the
// content comes to; a caller wanting a fixed one passes `height` on the node or calls
// fit() on what comes back.
export function render(node, columns) {
  if (columns <= 0) return []
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') {
    return wrap(String(node), columns).map((line) => pad(line, columns))
  }

  switch (node.type) {
    case 'text':
      return renderText(node, columns)
    case 'spacer':
      return renderSpacer(node, columns)
    case 'row':
      return renderRow(node, columns)
    case 'column':
      return renderColumn(node, columns)
    case 'box':
      return renderBox(node, columns)
    default:
      throw new Error(`unknown element type: ${node.type}`)
  }
}

function renderText(node, columns) {
  const props = node.props
  const value = node.children.map((child) => (child === null ? '' : String(child))).join('')
  const lines = props.wrap === false ? String(value).split('\n') : wrap(value, columns)
  return lines.map((line) => pad(style(line, styleNames(props)), columns, props.align || 'left'))
}

// Style names live on the props as flags (`{ dim: true }`) so a screen reads as attributes
// rather than an array of strings.
const STYLE_FLAGS = [
  'bold',
  'dim',
  'italic',
  'underline',
  'inverse',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'black'
]

function styleNames(props) {
  const names = STYLE_FLAGS.filter((flag) => props[flag])
  if (props.color) names.push(props.color)
  return names
}

function renderSpacer(node, columns) {
  const rows = node.props.rows ?? 0
  return Array.from({ length: rows }, () => ' '.repeat(columns))
}

function renderColumn(node, columns) {
  const gap = node.props.gap || 0
  const blocks = node.children.map((child) => render(child, columns))
  const height = node.props.height

  if (typeof height === 'number') {
    const content = blocks.reduce((total, block) => total + block.length, 0)
    const slack = height - content - gap * Math.max(0, blocks.length - 1)
    if (slack > 0) grow(node, blocks, columns, slack)
  }

  const lines = []
  blocks.forEach((block, index) => {
    if (index > 0) for (let i = 0; i < gap; i++) lines.push(' '.repeat(columns))
    lines.push(...block)
  })
  return typeof height === 'number' ? fit(lines, height, columns) : lines
}

// A column taller than its content hands the difference to its first `grow` child. What
// that means depends on what the child is, and the distinction is what decides whether
// this UI looks laid out or looks like text with holes in it:
//
//   a box     is redrawn taller, so its border reaches the bottom of the space it was
//             given. This is what pins a footer down while the pane above it fills the
//             screen.
//   a column  is redrawn taller too, and puts the same question to its own children —
//             which is how a pane nested two deep still stretches.
//   anything  else gets blank lines after it. A line of text has no inside to fill.
function grow(node, blocks, columns, slack) {
  const index = node.children.findIndex((child) => child?.props?.grow)
  if (index === -1) return
  const child = node.children[index]

  if ((child.type === 'box' || child.type === 'column') && typeof child.props.height !== 'number') {
    const taller = { ...child, props: { ...child.props, height: blocks[index].length + slack } }
    blocks[index] = render(taller, columns)
    return
  }

  blocks[index] = [...blocks[index], ...blank(columns, slack)]
}

// Children take their natural width; those with `grow` split the remainder in proportion
// to it. A row narrower than its content cuts from the growing children first, and from
// the last child when there are none — something has to give, and it should not be the
// label on the left.
function renderRow(node, columns) {
  const gap = node.props.gap || 0
  const children = node.children
  if (!children.length) return []

  const gaps = gap * (children.length - 1)
  const natural = children.map(measure)
  const grow = children.map((child) => Number(child?.props?.grow || 0))
  const totalGrow = grow.reduce((a, b) => a + b, 0)

  const widths = natural.slice()
  const slack = columns - gaps - natural.reduce((a, b) => a + b, 0)

  if (slack > 0 && totalGrow > 0) {
    let handed = 0
    grow.forEach((factor, index) => {
      if (!factor) return
      const share =
        index === grow.lastIndexOf(Math.max(...grow.filter(Boolean)))
          ? slack - handed
          : Math.floor((slack * factor) / totalGrow)
      widths[index] += share
      handed += share
    })
  } else if (slack < 0) {
    // Overflow: take it off the growing children, then off the last one.
    let over = -slack
    const order = grow.map((factor, index) => [factor, index]).filter(([factor]) => factor)
    const victims = order.length ? order.map(([, index]) => index) : [children.length - 1]
    for (const index of victims) {
      const take = Math.min(over, widths[index])
      widths[index] -= take
      over -= take
      if (!over) break
    }
  }

  const blocks = children.map((child, index) => render(child, widths[index]))
  const height = Math.max(0, ...blocks.map((block) => block.length))
  const lines = []
  for (let line = 0; line < height; line++) {
    const parts = blocks.map((block, index) => block[line] ?? ' '.repeat(widths[index]))
    lines.push(pad(parts.join(' '.repeat(gap)), columns))
  }
  return lines
}

function renderBox(node, columns) {
  const props = node.props
  const bordered = props.border !== false
  const chars =
    BORDERS[typeof props.border === 'string' ? props.border : 'single'] || BORDERS.single
  const inset = padding(props.padding)
  const outer = Math.min(columns, typeof props.width === 'number' ? props.width : columns)
  const inner = Math.max(0, outer - (bordered ? 2 : 0) - inset.left - inset.right)

  const content = renderColumn(
    {
      type: 'column',
      props: { gap: props.gap || 0, height: innerHeight(props, bordered, inset) },
      children: node.children
    },
    inner
  )

  const body = [...blank(inner, inset.top), ...content, ...blank(inner, inset.bottom)]
  const fitted =
    typeof props.height === 'number'
      ? fit(body, innerHeight(props, bordered, inset) + inset.top + inset.bottom, inner)
      : body

  const left = ' '.repeat(inset.left)
  const right = ' '.repeat(inset.right)
  const rows = fitted.map((line) =>
    bordered
      ? `${styleBorder(chars.v, props)}${left}${line}${right}${styleBorder(chars.v, props)}`
      : `${left}${line}${right}`
  )

  if (bordered) {
    rows.unshift(topBorder(chars, props, outer))
    rows.push(styleBorder(`${chars.bl}${chars.h.repeat(Math.max(0, outer - 2))}${chars.br}`, props))
  }
  return rows.map((line) => pad(line, columns))
}

// A title sits in the top border, one space either side, and is cut rather than allowed to
// push the corner off the end of a narrow terminal.
function topBorder(chars, props, outer) {
  const span = Math.max(0, outer - 2)
  if (!props.title) {
    return styleBorder(`${chars.tl}${chars.h.repeat(span)}${chars.tr}`, props)
  }
  const label = ` ${cut(props.title, Math.max(0, span - 4))} `
  const rest = Math.max(0, span - width(label) - 1)
  return (
    styleBorder(`${chars.tl}${chars.h}`, props) +
    label +
    styleBorder(`${chars.h.repeat(rest)}${chars.tr}`, props)
  )
}

function styleBorder(text, props) {
  return style(text, styleNames({ dim: props.dim, color: props.borderColor }))
}

function innerHeight(props, bordered, inset) {
  if (typeof props.height !== 'number') return undefined
  return Math.max(0, props.height - (bordered ? 2 : 0) - inset.top - inset.bottom)
}

function blank(columns, rows) {
  return Array.from({ length: rows }, () => ' '.repeat(columns))
}

// Exactly `rows` lines: padded when short, cut when long. Cutting from the bottom rather
// than the top, so what a screen puts first stays on screen when the terminal is small.
export function fit(lines, rows, columns) {
  if (lines.length === rows) return lines
  if (lines.length > rows) return lines.slice(0, rows)
  return [...lines, ...blank(columns, rows - lines.length)]
}
