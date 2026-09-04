import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/** Every suite in this project, run in order, with one summary at the end. */
const SUITES = ['playback.mjs', 'queue.mjs', 'security.mjs']

const failed = []

for (const suite of SUITES) {
  console.log(`\n${'='.repeat(64)}\n${suite}\n${'='.repeat(64)}`)
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, suite)], { stdio: 'inherit' })
    child.on('exit', (value) => done(value ?? 1))
  })
  if (code !== 0) failed.push(suite)
}

console.log(`\n${'='.repeat(64)}`)
if (failed.length > 0) {
  console.error(`${failed.length} suite(s) failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`All ${SUITES.length} suites passed`)
