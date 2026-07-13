/** Registers the .lua text loader (see lua-loader.mjs). Used via `tsx --import`. */
import { register } from 'node:module'
register('./lua-loader.mjs', import.meta.url)
