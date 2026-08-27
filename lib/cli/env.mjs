// Our name, and whether this is a standalone build or a `bare bin.mjs` checkout — dev
// shifts argv by one and keeps storage out of the user's persistent directory.
import path from 'bare-path'
import pkg from '../../package.json'

export const appName = pkg.productName || pkg.name
export const isDev = path.basename(Bare.argv[0], path.extname(Bare.argv[0])) === 'bare'
