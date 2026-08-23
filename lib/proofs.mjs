import './polyfills.mjs'
import { serializeProofs, deserializeProofs } from '@cashu/cashu-ts'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'bare-fs'
import path from 'bare-path'

// `store` is a path to a folder; proofs are always kept in <store>/proofs.json
function storeFile(store) {
  return path.join(store, 'proofs.json')
}

export function saveProofs(store, proofs) {
  if (!existsSync(store)) mkdirSync(store, { recursive: true })
  writeFileSync(storeFile(store), JSON.stringify(serializeProofs(proofs)))
}

export function loadProofs(store) {
  const file = storeFile(store)
  if (!existsSync(file)) {
    if (!existsSync(store)) mkdirSync(store, { recursive: true })
    writeFileSync(file, '[]')
    return []
  }
  // Read — deserializeProofs accepts a raw JSON string directly (no JSON.parse needed)
  const json = readFileSync(file, 'utf-8')
  return deserializeProofs(json)
}
