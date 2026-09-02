// The licenses of everything compiled into this binary, printed by the binary itself.
//
// This is not a convenience. A cashme binary carries its whole dependency tree inside it,
// and those licenses ask to be distributed with the code — but the three ways cashme is
// installed do not all carry a file. The release archives do. A pear install does not:
// pear-install mirrors `/by-arch/<host>/app/cashme` out of the drive and moves that one
// file into place, and the OTA updater copies the same single path over it. So the notices
// have to be in the binary, or a pear user has no copy of them at all.
import process from 'bare-process'
import { totals, packages, embedded, full, total } from '../third-party-notices.mjs'

export function run({ flags }) {
  // The notices are what the command produces, so they go to stdout — `cashme licenses
  // --full > NOTICES.md` should give a file worth having, and a pipe to a pager should
  // show the text rather than the commentary around it.
  // Written rather than logged, so that `--full` is byte for byte the file the release
  // archives ship and the two can be diffed.
  if (flags.full) {
    process.stdout.write(full)
    return
  }

  console.log('cashme is Apache-2.0. Copyright (c) 2026 Mokhtar Naamani.')
  console.log('')
  console.log(`Built with ${total} third-party packages, all permissively licensed:`)
  console.log('')

  const column = Math.max(...totals.map(([license]) => license.length))
  for (const [license, count] of totals) {
    console.log(`  ${license.padEnd(column)}  ${count}`)
  }

  console.log('')
  for (const [id, license, note] of packages) {
    console.log(`  ${id} — ${license}${note ? ` (${note})` : ''}`)
  }

  if (embedded.length) {
    console.log('')
    console.log('Third-party C and C++ compiled into the prebuilt binaries, which does not')
    console.log('appear in the dependency tree above:')
    console.log('')
    for (const { name, license, via, source } of embedded) {
      console.log(`  ${name} — ${license}, via ${via}`)
      console.log(`    ${source}`)
    }
  }

  console.log('')
  console.log('`cashme licenses --full` prints the license texts themselves, and the NOTICE')
  console.log('files reproduced under section 4(d) of the Apache License.')
}
