import { DEFAULT_UNIT, getTokenMetadata } from '@cashu/coco-core'
import { normalizeMintUrl } from '../mint-url.mjs'

export function inspectToken(token) {
  const meta = getTokenMetadata(token)
  return { mintUrl: meta.mint, unit: meta.unit, amount: meta.amount }
}

export function isTrustedMint(wallet, mintUrl) {
  return wallet.manager.mint.isTrustedMint(normalizeMintUrl(mintUrl))
}

export async function knownMints(wallet) {
  const mints = await wallet.manager.mint.getAllMints()
  return mints.map((mint) => ({
    mintUrl: normalizeMintUrl(mint.mintUrl),
    name: mint.name || '',
    trusted: Boolean(mint.trusted)
  }))
}

export async function trustMint(wallet, mintUrl) {
  const url = normalizeMintUrl(mintUrl)
  await wallet.manager.mint.addMint(url, { trusted: true })
  await wallet.manager.mint.trustMint(url)
  return url
}

export async function untrustMint(wallet, mintUrl) {
  const url = normalizeMintUrl(mintUrl)
  const known = await knownMints(wallet)
  if (!known.some((mint) => mint.mintUrl === url)) {
    throw new Error(`${url} is not a mint this wallet knows`)
  }

  try {
    await wallet.manager.mint.untrustMint(url)
  } catch (err) {
    if (await wallet.manager.mint.isTrustedMint(url)) throw err
  }
  return url
}

export async function receiveToken(wallet, token) {
  await wallet.manager.wallet.receive(token)
  return normalizeMintUrl(inspectToken(token).mintUrl)
}

export function restoreProofs(wallet, mintUrl) {
  return wallet.manager.wallet.restore(mintUrl)
}

export function balances(wallet, scope) {
  return wallet.manager.wallet.balances.byMintAndUnit(scope)
}

export function totalBalances(wallet, scope) {
  return wallet.manager.wallet.balances.totalByUnit(scope)
}

export async function mintDetails(wallet) {
  const byMint = await balances(wallet)
  const ready = await wallet.repos.proofRepository.getAllReadyProofs()
  const reserved = await wallet.repos.proofRepository.getReservedProofs()

  const held = new Map()
  const at = (mintUrl, unit) => {
    if (!held.has(mintUrl)) held.set(mintUrl, new Map())
    const byUnit = held.get(mintUrl)
    if (!byUnit.has(unit)) byUnit.set(unit, { ready: 0, reserved: 0, counts: new Map() })
    return byUnit.get(unit)
  }
  for (const proof of ready) {
    const tally = at(proof.mintUrl, proof.unit)
    tally.ready += 1
    const amount = Number(proof.amount)
    tally.counts.set(amount, (tally.counts.get(amount) ?? 0) + 1)
  }
  for (const proof of reserved) at(proof.mintUrl, proof.unit).reserved += 1

  const registered = await knownMints(wallet)
  const trusted = new Map(registered.map((mint) => [mint.mintUrl, mint]))
  const mints = new Set([...Object.keys(byMint), ...held.keys(), ...trusted.keys()])

  return [...mints].map((mintUrl) => {
    const byUnit = held.get(mintUrl) ?? new Map()
    const units = new Set([...Object.keys(byMint[mintUrl] ?? {}), ...byUnit.keys()])
    return {
      mintUrl,
      trusted: trusted.get(mintUrl)?.trusted ?? false,
      units: [...units].map((unit) => {
        const figures = byMint[mintUrl]?.[unit] ?? {}
        const tally = byUnit.get(unit) ?? { ready: 0, reserved: 0, counts: new Map() }
        return {
          unit,
          spendable: Number(figures.spendable ?? 0),
          reserved: Number(figures.reserved ?? 0),
          proofs: tally.ready,
          reservedProofs: tally.reserved,
          denominations: [...tally.counts.entries()]
            .sort((a, b) => b[0] - a[0])
            .map(([amount, count]) => ({ amount, count }))
        }
      })
    }
  })
}

export async function richestMint(wallet, unit = DEFAULT_UNIT) {
  let best = null
  for (const [mintUrl, byUnit] of Object.entries(await balances(wallet, { units: [unit] }))) {
    const spendable = Number(byUnit[unit]?.spendable ?? 0)
    if (!best || spendable > best.spendable) best = { mintUrl, spendable }
  }
  return best && best.spendable > 0 ? best.mintUrl : null
}

export async function mintWithBalance(wallet, amount, unit = DEFAULT_UNIT, allowed = null) {
  const byMint = await balances(wallet, { units: [unit] })
  for (const [mintUrl, byUnit] of Object.entries(byMint)) {
    if (allowed && !allowed.includes(mintUrl)) continue
    if (Number(byUnit[unit]?.spendable ?? 0) >= amount) return mintUrl
  }
  return null
}
