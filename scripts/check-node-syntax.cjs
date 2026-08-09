'use strict'

// Syntax-checks every CommonJS file the app ships, so a typo in a module that
// only loads at runtime fails `npm run check` instead of at startup.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOTS = ['core', 'server', 'electron', 'scripts']
const root = path.resolve(__dirname, '..')

function collect(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, found)
    else if (entry.name.endsWith('.cjs')) found.push(full)
  }
  return found
}

const files = ROOTS
  .map((name) => path.join(root, name))
  .filter((dir) => fs.existsSync(dir))
  .flatMap((dir) => collect(dir))
  .sort()

let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failed += 1
    process.stderr.write(`${path.relative(root, file)}\n${error.stderr?.toString() ?? error.message}\n`)
  }
}

console.log(`checked ${files.length} CommonJS files${failed ? `, ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
