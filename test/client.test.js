/**
 * @file Unit tests for Kestrel client-side Cordis plugin (lib/client.js).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('lib/client.js registers with __ModuleLoader__ and exports valid Cordis plugin', () => {
  const code = readFileSync('lib/client.js', 'utf8')

  let registeredModule = null
  const mockModuleLoader = {
    load(mod) {
      registeredModule = mod
    },
  }

  // Create a mock browser context
  const mockContext = {
    window: {
      __ModuleLoader__: mockModuleLoader,
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }),
      head: { appendChild: () => {} },
    },
    console,
    module: { exports: {} },
  }
  mockContext.globalThis = mockContext.window

  vm.createContext(mockContext)
  vm.runInContext(code, mockContext)

  assert.ok(registeredModule, '__ModuleLoader__.load was called')
  assert.equal(registeredModule.id, 'dsh-deep-research')
  assert.equal(typeof registeredModule.factory, 'function')

  // Mock React
  const mockReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [init, () => {}],
    useEffect: (fn) => fn(),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  }

  const mockRequire = (id) => {
    if (id === 'react') return mockReact
    return {}
  }

  const plugin = registeredModule.factory(mockRequire)
  assert.ok(plugin, 'plugin factory returned an object')
  assert.deepEqual([...plugin.inject], ['slots'], 'declares injection of slots')
  assert.equal(typeof plugin.apply, 'function')

  // Test apply(ctx)
  const registeredSlots = []
  const injectedSlots = []
  const effects = []

  const mockSlots = {
    inject(name, cb) {
      injectedSlots.push(name)
      cb()
    },
    register(options, component) {
      registeredSlots.push({ options, component })
      return () => {}
    },
  }

  const mockCtx = {
    slots: mockSlots,
    effect(cb, label) {
      effects.push({ cb, label })
      return () => {}
    },
  }

  plugin.apply(mockCtx)

  assert.ok(effects.length > 0, 'registered style effect')
  assert.ok(injectedSlots.includes('conversation.chat.assistant-actions'))
  assert.ok(injectedSlots.includes('conversation.input.left'))
  assert.ok(injectedSlots.includes('settings.section'))

  // Check specific registrations
  const assistantAction = registeredSlots.find((r) => r.options.name === 'conversation.chat.assistant-actions')
  assert.ok(assistantAction, 'registered assistant-actions')
  assert.equal(assistantAction.options.id, 'kestrel-verify-action')

  const composerToggle = registeredSlots.find((r) => r.options.name === 'conversation.input.left')
  assert.ok(composerToggle, 'registered composer button')
  assert.equal(composerToggle.options.id, 'kestrel-composer-toggle')

  const settingsSection = registeredSlots.find((r) => r.options.name === 'settings.section')
  assert.ok(settingsSection, 'registered settings section')
  assert.equal(settingsSection.options.id, 'kestrel-settings')
  assert.ok(settingsSection.options.label().includes('Kestrel'))
})
