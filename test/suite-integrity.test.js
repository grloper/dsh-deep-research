/**
 * @file Guards the test suite against silently discovering nothing.
 *
 * CI caught `npm test` passing zero tests on Node 20: the script used a
 * "test/**\/*.test.js" glob, but Node 20's runner does not expand `**` itself and
 * no shell expands it on Windows, so the pattern matched no files and the run
 * exited without testing anything. A suite that tests nothing must fail loudly
 * rather than report success.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const testDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(testDir, '..')

test('every test file in test/ is discoverable by the runner', () => {
  const files = readdirSync(testDir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  const testFiles = files.filter((f) => f.endsWith('.test.js'))

  assert.ok(testFiles.length >= 10, `expected the full suite, found ${testFiles.length} test files`)

  // Node's directory-mode discovery matches *.test.*, *-test.*, and test.*.
  // Anything else in test/ is a helper and must not look like a test file.
  for (const f of files) {
    if (f.endsWith('.test.js')) continue
    assert.ok(
      !/(^|[.-])test\.(js|mjs)$/.test(f),
      `${f} would be picked up as a test file but is not named *.test.js`,
    )
  }
})

test('the test script uses a pattern Node 20 can actually resolve', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  for (const name of ['test', 'test:serial', 'check']) {
    const script = pkg.scripts[name]
    assert.ok(script, `missing script: ${name}`)
    assert.ok(
      !script.includes('**'),
      `script "${name}" uses a ** glob, which Node 20 does not expand and Windows shells do not either`,
    )
    assert.match(script, /node --test/, `script "${name}" must invoke the node test runner`)
  }
})

test('declared engine range matches what the scripts actually support', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  assert.match(pkg.engines.node, />=20/, 'package claims Node 20 support')
  // The store degrades from node:sqlite to a JSON backend below Node 22.5, which
  // is why Node 20 is a supported-and-tested target rather than an accident.
  const store = readFileSync(join(rootDir, 'lib', 'store.js'), 'utf8')
  assert.ok(store.includes("'node:sqlite'"), 'sqlite backend must be attempted')
  assert.ok(store.includes("this.backend = 'json'"), 'a JSON fallback must exist for Node 20')
})
