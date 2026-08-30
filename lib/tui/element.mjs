// The element tree. `h` is the only way to build one, and it makes plain objects — the
// runtime resolves function components against these, and the layout draws the rest.
//
// Five host types, which is all a terminal needs: text, a row, a column, a bordered box,
// and a spacer that eats whatever space is left. Anything more expressive is a component
// built out of these (see screens/), not another type here.
export const HOST_TYPES = new Set(['text', 'box', 'row', 'column', 'spacer'])

export function h(type, props = null, ...children) {
  const { key = null, ...rest } = props || {}
  return {
    type,
    key,
    props: rest,
    // Flattened so a component can `...list` its children, and stripped of the nulls a
    // conditional child leaves behind (`show && h(...)`).
    children: children
      .flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false)
  }
}

// Shorthands, because a screen is mostly these five and h('column', null, ...) reads badly
// stacked ten deep.
export const text = (value, props = null) => h('text', props, value)
export const box = (props, ...children) => h('box', props, ...children)
export const row = (props, ...children) => h('row', props, ...children)
export const column = (props, ...children) => h('column', props, ...children)
export const spacer = (props = null) => h('spacer', { grow: 1, ...props })

export function isElement(value) {
  return value !== null && typeof value === 'object' && 'type' in value && 'props' in value
}
