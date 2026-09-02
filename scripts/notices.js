#!/usr/bin/env node
'use strict'

// Collect the license of every package that ends up inside a cashme build, and write them
// out as THIRD-PARTY-NOTICES.md.
//
// The standalone binaries are one file with the whole production dependency tree compiled
// into them, so every notice those licenses ask to travel with the code has to be shipped
// beside the binary — Apache-2.0 §4(d) for the NOTICE files, and the MIT and ISC
// permission notices for the rest. Nothing about that is automatic, hence this.
//
//   node scripts/notices.js              regenerate THIRD-PARTY-NOTICES.md
//   node scripts/notices.js --check      fail if the file on disk is not what would be written
//   node scripts/notices.js --copy-to d  regenerate, then place it beside a built binary
//
// A package with no license text anywhere is an error, not a blank line: a new dependency
// that publishes nothing to attribute stops the build until someone has looked at it and
// written down what is true in scripts/notices-overrides.json.
//
// Two things are written. THIRD-PARTY-NOTICES.md ships beside the binary in the release
// archives, and lib/third-party-notices.mjs is compiled into the binary itself so that
// `cashme licenses` has them wherever it runs — a pear install fetches the one binary out
// of the drive and nothing else, so a file next to it would never arrive.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'THIRD-PARTY-NOTICES.md')
const bundle = path.join(root, 'lib', 'third-party-notices.mjs')
const overrides = require('./notices-overrides.json')

// npm on Windows is a shim script rather than an executable, so a bare 'npm' is not
// something CreateProcess can find and spawning it is ENOENT. scripts/make.js goes through
// a shell for the same reason; here the .cmd is enough, since the arguments are ours and
// never need quoting.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const LICENSE_FILE = /^(licen[cs]e|copying)(\.|$)/i
const NOTICE_FILE = /^notice(\.|$)/i

function main() {
  const check = process.argv.includes('--check')
  const packages = collect()
  const rendered = render(packages)
  const bundled = renderModule(packages, rendered)

  if (check) {
    const stale = [
      [output, 'THIRD-PARTY-NOTICES.md', rendered],
      [bundle, 'lib/third-party-notices.mjs', bundled]
    ].filter(([file, , want]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== want)

    if (stale.length === 0) {
      console.log(`Notices are up to date (${packages.length} packages)`)
      return
    }
    for (const [, name] of stale) console.error(`${name} is out of date.`)
    console.error('The dependency tree has moved since they were last written.')
    console.error('Run `npm run notices` and commit the result.')
    process.exit(1)
  }

  fs.writeFileSync(output, rendered)
  fs.writeFileSync(bundle, bundled)
  console.log(
    `Wrote THIRD-PARTY-NOTICES.md and lib/third-party-notices.mjs — ${packages.length} packages`
  )

  // A build directory is what gets archived and handed to someone, so the notices have to
  // be in it. The license and our own NOTICE go along for the same reason.
  const to = argValue('--copy-to')
  if (to) {
    const dir = path.resolve(root, to)
    fs.mkdirSync(dir, { recursive: true })
    for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
      fs.copyFileSync(path.join(root, file), path.join(dir, file))
    }
    console.log(`Copied LICENSE, NOTICE and THIRD-PARTY-NOTICES.md into ${to}`)
  }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? null : process.argv[i + 1]
}

// Every package npm would install for a production run, flattened and deduplicated by
// name@version. --long carries the license field and the on-disk path, which is where the
// texts themselves have to be read from.
function collect() {
  const json = execFileSync(NPM, ['ls', '--omit=dev', '--all', '--json', '--long'], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 256,
    encoding: 'utf8'
  })

  const seen = new Map()
  const workspaces = new Set(readWorkspaceNames())

  walk(JSON.parse(json))

  function walk(node) {
    for (const [name, dep] of Object.entries(node.dependencies || {})) {
      const id = `${name}@${dep.version}`
      if (seen.has(id)) continue
      seen.set(id, null)
      // Our own workspace packages are covered by the repo's LICENSE and NOTICE. They are
      // not third party and listing them here would only claim otherwise.
      if (!workspaces.has(name)) seen.set(id, describe(name, dep))
      walk(dep)
    }
  }

  const packages = [...seen.values()].filter(Boolean)
  packages.sort((a, b) => a.id.localeCompare(b.id))
  return packages
}

function readWorkspaceNames() {
  const dir = path.join(root, 'packages')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name, 'package.json'))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).name)
}

function describe(name, dep) {
  const id = `${name}@${dep.version}`
  const override = overrides.packages[name]

  // An unmet optional or peer dependency has a path npm never created. Nothing was
  // installed, so nothing is bundled, so there is nothing to attribute.
  if (!dep.path || !fs.existsSync(dep.path)) return null

  const files = fs.readdirSync(dep.path)
  const found = files.find((file) => LICENSE_FILE.test(file))
  const notices = files
    .filter((file) => NOTICE_FILE.test(file))
    .map((file) => read(path.join(dep.path, file)))

  let license = typeof dep.license === 'string' ? dep.license : null
  let text = found ? read(path.join(dep.path, found)) : null
  let note = null

  if (!text && override) {
    license = override.license || license
    note = override.note || null
    text = override.text ? override.text.trimEnd() : null
    if (override.useCanonical) text = canonical(override.useCanonical)
  }

  if (!text) {
    throw new Error(
      `${id} ships no license text and has no entry in scripts/notices-overrides.json.\n` +
        `Look up what ${name} is actually licensed under, then add it there — with a note\n` +
        `saying where the text came from, since the package itself does not carry one.`
    )
  }

  if (!license) {
    throw new Error(
      `${id} declares no license. Add it to scripts/notices-overrides.json with the\n` +
        `license its source repository names.`
    )
  }

  return { id, name, version: dep.version, license, text, note, notices }
}

// The full Apache-2.0 text, borrowed from a package that does ship it, for the handful of
// Apache packages that publish none of their own. Same license, same words.
let apache = null
function canonical(id) {
  if (id !== 'Apache-2.0') throw new Error(`no canonical text for ${id}`)
  if (apache) return apache
  const donor = path.join(root, 'LICENSE')
  apache = read(donor)
  return apache
}

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd()
}

// The same notices as a module, so they are inside the binary rather than beside it.
// Compiling the markdown in whole is what --full prints; the structured half is what the
// default listing is built from, and reading it back out of the markdown would be a parser
// nobody needs.
function renderModule(packages, markdown) {
  const totals = [...group(packages, (pkg) => pkg.license)]
    .map(([license, list]) => [license, list.length])
    .sort((a, b) => b[1] - a[1])

  const listed = packages.map((pkg) => [pkg.id, pkg.license, pkg.note])

  return [
    '// Generated by scripts/notices.js. Do not edit — run `npm run notices`.',
    '//',
    '// Compiled into the binary so `cashme licenses` can print it anywhere the binary got',
    '// to, including a pear install, which fetches the executable and nothing else.',
    '',
    `export const total = ${packages.length}`,
    '',
    `export const totals = ${JSON.stringify(totals)}`,
    '',
    `export const packages = ${JSON.stringify(listed)}`,
    '',
    `export const embedded = ${JSON.stringify(overrides.embedded || [])}`,
    '',
    `export const full = ${JSON.stringify(markdown)}`,
    ''
  ].join('\n')
}

function render(packages) {
  const out = []

  out.push('# Third-party notices')
  out.push('')
  out.push(
    'cashme is distributed as a standalone binary with its entire production dependency',
    'tree compiled in. This file carries the license and attribution notices those',
    'dependencies require to travel with the code. It is generated — run `npm run notices`',
    'to rebuild it from the installed tree, and do not edit it by hand.',
    ''
  )
  out.push('cashme itself is Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).')
  out.push('')

  const byLicense = group(packages, (pkg) => pkg.license)
  out.push('## Summary')
  out.push('')
  out.push('| License | Packages |')
  out.push('| --- | --- |')
  for (const [license, list] of sortGroups(byLicense)) {
    out.push(`| ${license} | ${list.length} |`)
  }
  out.push(`| **Total** | **${packages.length}** |`)
  out.push('')

  out.push('## Packages')
  out.push('')
  for (const pkg of packages) {
    out.push(`- \`${pkg.id}\` — ${pkg.license}${pkg.note ? ` (${pkg.note})` : ''}`)
  }
  out.push('')

  const embedded = overrides.embedded || []
  if (embedded.length) {
    out.push('## Embedded native code')
    out.push('')
    out.push(
      'Several dependencies ship prebuilt binaries with third-party C and C++ compiled',
      'into them. That code is inside the cashme binary too, and is listed here because it',
      'does not appear in the npm dependency tree above.',
      ''
    )
    for (const item of embedded) {
      out.push(`- **${item.name}** — ${item.license}, via \`${item.via}\`  `)
      out.push(`  ${item.source}`)
    }
    out.push('')
  }

  // One copy of each distinct license text, naming everything it covers. A hundred
  // identical copies of the Apache license would satisfy the same obligation and be
  // unreadable, which defeats the point of shipping notices at all.
  out.push('## License texts')
  out.push('')
  const byText = group(packages, (pkg) => pkg.text)
  for (const [text, list] of sortGroups(byText)) {
    out.push(`### ${list[0].license} (${list.length} package${list.length === 1 ? '' : 's'})`)
    out.push('')
    out.push(`Covers ${list.map((pkg) => `\`${pkg.id}\``).join(', ')}.`)
    out.push('')
    out.push('```')
    out.push(text)
    out.push('```')
    out.push('')
  }

  // Apache-2.0 §4(d): a NOTICE file in a dependency has to be reproduced in the
  // distributions of anything derived from it.
  const allNotices = []
  for (const pkg of packages) {
    for (const notice of pkg.notices) {
      if (!allNotices.includes(notice)) allNotices.push(notice)
    }
  }
  if (allNotices.length) {
    out.push('## NOTICE files')
    out.push('')
    out.push(
      'Reproduced as required by section 4(d) of the Apache License, Version 2.0, from the',
      'NOTICE files of the Apache-licensed dependencies listed above.',
      ''
    )
    for (const notice of allNotices.sort()) {
      out.push('```')
      out.push(notice)
      out.push('```')
      out.push('')
    }
  }

  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  )
}

function group(items, key) {
  const map = new Map()
  for (const item of items) {
    const k = key(item)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(item)
  }
  return map
}

function sortGroups(map) {
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
}

main()
