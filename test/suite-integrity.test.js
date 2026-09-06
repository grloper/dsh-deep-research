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

test('test/ contains only real test files, so runner discovery stays clean', () => {
  const files = readdirSync(testDir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  const testFiles = files.filter((f) => f.endsWith('.test.js'))

  assert.ok(testFiles.length >= 15, `expected the full suite, found ${testFiles.length} test files`)

  // Node discovers test files by walking the working directory, so a non-test
  // helper parked in test/ gets executed as if it were a test. The benchmark
  // used to live here and was run as part of the suite; it now lives in bench/.
  assert.deepEqual(
    files.filter((f) => !f.endsWith('.test.js')),
    [],
    'test/ must contain only *.test.js files',
  )
})

test('the test script uses an invocation Node 20 can actually resolve', () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  for (const name of ['test', 'test:serial', 'check']) {
    const script = pkg.scripts[name]
    assert.ok(script, `missing script: ${name}`)
    assert.match(script, /node --test/, `script "${name}" must invoke the node test runner`)
    assert.ok(
      !script.includes('**'),
      `script "${name}" uses a ** glob, which Node 20 does not expand and Windows shells do not either`,
    )
    // `node --test <dir>` treats the path as a module specifier and fails with
    // "Cannot find module". Bare `node --test` walks the cwd, which is the only
    // form that behaves identically on Node 20 through 24 and on both shells.
    // Compare positional arguments only; --test-* flags are not paths.
    const positional = script
      .split(/\s+/)
      .slice(1) // drop "node"
      .filter((token) => !token.startsWith('-'))
    assert.deepEqual(
      positional,
      [],
      `script "${name}" must not pass a path to --test (found: ${positional.join(', ')})`,
    )
  }
  assert.match(pkg.scripts.bench, /bench\/run\.mjs/, 'bench must point at the relocated benchmark')
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
