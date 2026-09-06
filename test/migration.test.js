/**
 * @file Regression tests for the v0.3 store-path migration.
 *
 * The project was renamed from VERITAS to Kestrel, moving the evidence store
 * from `.dsh/veritas/` to `.dsh/kestrel/`. The store exists so findings compound
 * across runs, so an upgrade that silently starts from an empty database would
 * discard the one thing the store promises to keep.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { defaultStorePath, migrateLegacyStore } from '../lib/store.js'

/** @returns {string} a throwaway home directory */
function makeHome() {
  return mkdtempSync(join(tmpdir(), 'kestrel-migrate-'))
}

test('a legacy veritas store is carried forward to the kestrel path', () => {
  const home = makeHome()
  try {
    const legacyDir = join(home, '.dsh', 'veritas')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'evidence.db'), 'legacy-evidence-bytes')

    const resolved = defaultStorePath(home)

    assert.ok(resolved.includes('kestrel'), 'the resolved path must be the new location')
    assert.ok(existsSync(resolved), 'the legacy store must be migrated to the new path')
    assert.equal(readFileSync(resolved, 'utf8'), 'legacy-evidence-bytes')
    assert.ok(
      existsSync(join(legacyDir, 'evidence.db')),
      'the original must be left in place rather than deleted',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migration carries the WAL sidecars so committed transactions survive', () => {
  const home = makeHome()
  try {
    const legacyDir = join(home, '.dsh', 'veritas')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'evidence.db'), 'db')
    writeFileSync(join(legacyDir, 'evidence.db-wal'), 'wal')
    writeFileSync(join(legacyDir, 'evidence.db-shm'), 'shm')

    const resolved = defaultStorePath(home)

    assert.equal(readFileSync(resolved + '-wal', 'utf8'), 'wal')
    assert.equal(readFileSync(resolved + '-shm', 'utf8'), 'shm')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an existing kestrel store is never overwritten by a legacy one', () => {
  const home = makeHome()
  try {
    mkdirSync(join(home, '.dsh', 'veritas'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'veritas', 'evidence.db'), 'OLD')
    mkdirSync(join(home, '.dsh', 'kestrel'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'kestrel', 'evidence.db'), 'CURRENT')

    const resolved = defaultStorePath(home)

    assert.equal(readFileSync(resolved, 'utf8'), 'CURRENT', 'current data must win')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a clean install without a legacy store is a no-op', () => {
  const home = makeHome()
  try {
    const resolved = defaultStorePath(home)
    assert.ok(resolved.includes('kestrel'))
    assert.equal(existsSync(resolved), false, 'nothing should be created just by resolving the path')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('migrateLegacyStore reports whether it moved anything and never throws', () => {
  const home = makeHome()
  try {
    const target = join(home, '.dsh', 'kestrel', 'evidence.db')
    assert.equal(migrateLegacyStore(home, target), false, 'no legacy store means no migration')

    mkdirSync(join(home, '.dsh', 'veritas'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'veritas', 'evidence.db'), 'x')
    assert.equal(migrateLegacyStore(home, target), true, 'a legacy store is migrated once')
    assert.equal(migrateLegacyStore(home, target), false, 'and not migrated twice')

    // An unusable home must degrade rather than throw.
    assert.doesNotThrow(() => migrateLegacyStore('\0invalid', '\0invalid'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
