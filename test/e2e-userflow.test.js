/**
 * @file End-to-end user-flow test: browser Client ↔ Host RPC ↔ engine.
 *
 * This exercises the exact path a user takes when they click "Verify" on an
 * assistant message. Before v0.2 this path was broken end to end: the Client
 * called `host.call('verify', …)` but the Host never registered a `verify`
 * handler, so the call always failed and the UI silently rendered a fabricated
 * verdict instead. Nothing in the old suite caught that, because each half was
 * only ever tested in isolation.
 *
 * Here the real client bundle is evaluated in a sandboxed DOM-ish context, wired
 * to a real `apply()` host through a real RPC boundary, and driven the way the
 * browser drives it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { apply, Verdict } from '../lib/index.js'

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Deterministic offline corpus shared by the flow tests. */
const SOURCE_TEXT =
  'The transit authority confirmed that the new line opened on 12 March 2024, ' +
  'serving an estimated 40,000 passengers on its first day of operation.'

/**
 * Boot a host with an in-memory store and an offline search/fetch/LLM stack, and
 * return its RPC surface exactly as the browser would see it.
 */
function bootHost({ judgeQuote, judgeVerdict = Verdict.SUPPORTED } = {}) {
  const handlers = new Map()
  const harness = { handle: (m, fn) => handlers.set(m, fn) }

  const ctx = {
    harness,
    tools: { register: () => () => {} },
    on: () => {},
    web: {
      search: async () => ({ sources: [{ url: 'https://transit.example.gov/opening', title: 'Line opening' }] }),
      fetch: async () => ({ content: SOURCE_TEXT, status: 200 }),
    },
    llm: {
      generate: async ({ prompt }) => {
        // Atomizer prompt asks for a JSON array of claim strings.
        if (/Return ONLY a JSON array of strings/.test(prompt)) {
          return '["The new transit line opened on 12 March 2024."]'
        }
        // Judge prompt asks for a single JSON verdict object.
        return JSON.stringify({ verdict: judgeVerdict, quote: judgeQuote, score: 0.9 })
      },
    },
  }

  const result = apply(ctx, { storePath: ':memory:', maxSources: 2 })
  return {
    result,
    host: {
      call: (method, args) => {
        const fn = handlers.get(method)
        if (!fn) throw new Error(`no host handler: ${method}`)
        return fn(args)
      },
    },
  }
}

/**
 * Evaluate the client bundle and mount its message-action component, returning
 * the captured React tree plus the state-setter driven by the user's click.
 */
function mountClient(host) {
  let registered = null
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    host,
    setTimeout,
    clearTimeout,
    document: {
      getElementById: () => null,
      createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, set textContent(_v) {} }),
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    module: { exports: {} },
  }
  sandbox.window = { __ModuleLoader__: { load: (m) => (registered = m) } }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox)

  assert.ok(registered, 'client bundle must self-register')

  // A minimal React double: hook state persists across renders and setters write
  // through immediately, so a handler invoked outside a render still observes the
  // values the component last read. `useCallback` intentionally returns the
  // freshest closure rather than a memoized one — memoizing here would test the
  // double's caching rather than the component's behaviour.
  const states = []
  let cursor = 0
  const effects = []
  const refs = []
  let refCursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(init) {
      const i = cursor++
      if (states.length <= i) states[i] = init
      return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init = null) => {
      const i = refCursor++
      if (refs.length <= i) refs[i] = { current: init }
      return refs[i]
    },
  }

  const plugin = registered.factory((id) => (id === 'react' ? React : {}))
  const slots = []
  plugin.apply({
    slots: {
      inject: (name, cb) => cb(),
      register: (options, component) => { slots.push({ options, component }); return () => {} },
    },
    effect: (cb) => { cb(); return () => {} },
  })

  const entry = slots.find((s) => s.options.name === 'conversation.chat.assistant-actions')
  assert.ok(entry, 'the Verify action must be registered')

  return {
    /**
     * Render the slot component. The slot registers a thin wrapper around the
     * real function component, so unwrap function elements until the concrete
     * host-element tree the user actually sees is reached.
     */
    render(props) {
      cursor = 0
      refCursor = 0
      let node = entry.component(props)
      let guard = 0
      while (node && typeof node === 'object' && typeof node.type === 'function' && guard++ < 5) {
        node = node.type(node.props || {})
      }
      return node
    },
    /** Run any effects the last render queued. */
    async flushEffects() {
      const queued = effects.splice(0, effects.length)
      for (const fn of queued) await fn()
    },
    states,
  }
}

/**
 * Walk a rendered element tree collecting all string content, descending into
 * function components so the text of nested elements is included too.
 */
function textOf(node, out = [], depth = 0) {
  if (node == null || node === false || depth > 40) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out, depth + 1); return out }
  if (typeof node !== 'object') return out
  if (node.props && node.props.children !== undefined) textOf(node.props.children, out, depth + 1)
  if (node.children) textOf(node.children, out, depth + 1)
  return out
}

/** Depth-first search for the first element matching a predicate. */
function findNode(node, predicate, depth = 0) {
  if (node == null || node === false || depth > 40) return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findNode(n, predicate, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (predicate(node)) return node
  const kids = [node.children, node.props && node.props.children].filter(Boolean)
  for (const k of kids) {
    const hit = findNode(k, predicate, depth + 1)
    if (hit) return hit
  }
  return null
}

/** Locate the primary Verify button in a rendered tree. */
function verifyButton(tree) {
  const btn = findNode(
    tree,
    (n) => n.type === 'button' && n.props && typeof n.props.onClick === 'function' && /veritas-action-btn/.test(n.props.className || ''),
  )
  assert.ok(btn, 'the Verify button must be present in the rendered tree')
  return btn
}

/**
 * Drive the full user gesture: render, click Verify, wait for the host round
 * trip, then re-render and return the text the user would now see.
 * @param {{render:Function}} ui
 * @param {object} props
 */
async function clickVerify(ui, props) {
  const tree = ui.render(props)
  // onClick is a plain (non-async) handler that kicks off async work, exactly as
  // a DOM event listener does, so awaiting it returns before the host round trip
  // finishes. Let the pending promise chain settle before reading state back.
  verifyButton(tree).props.onClick()
  await settle()
  // Re-render so the component re-reads the state the click committed.
  return textOf(ui.render(props)).join(' ')
}

/** Allow queued microtasks and timers to run to completion. */
function settle(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('E2E: clicking Verify runs the real host engine and renders its verdict', async () => {
  // The judge quotes the source verbatim, so the mechanical gate admits it.
  const { host } = bootHost({ judgeQuote: 'the new line opened on 12 March 2024' })
  const ui = mountClient(host)

  const props = { messageId: 'm1', text: 'The new transit line opened on 12 March 2024.' }

  // First render: no report yet, the button offers to verify.
  assert.ok(textOf(ui.render(props)).includes('Verify'))

  const rendered = await clickVerify(ui, props)

  assert.match(rendered, /Verified/, 'the button must reflect a completed verification')
  assert.match(rendered, /SUPPORTED/, 'the host verdict must be displayed')
  assert.match(rendered, /ICS:/, 'independence must be surfaced')
  assert.match(rendered, /12 March 2024/, 'the anchored quote must be shown to the user')
})

test('E2E: a fabricated judge quote yields UNVERIFIED, never a fake SUPPORTED', async () => {
  // The judge asserts support but quotes text that is not in the source.
  const { host } = bootHost({ judgeQuote: 'the line opened on 9 September 1999 carrying two million riders' })
  const ui = mountClient(host)

  const rendered = await clickVerify(ui, {
    messageId: 'm1',
    text: 'The new transit line opened on 12 March 2024.',
  })

  assert.match(rendered, /UNVERIFIED/, 'an unanchorable citation must not become support')
  assert.doesNotMatch(rendered, /SUPPORTED/, 'the fabricated verdict must not reach the user')
  assert.doesNotMatch(rendered, /1999/, 'the fabricated quote must never be displayed as evidence')
})

test('E2E: with no host engine the UI reports unavailability instead of guessing', async () => {
  // No `host` global at all — the pre-v0.2 code fabricated a verdict here.
  const ui = mountClient(undefined)

  const rendered = await clickVerify(ui, {
    messageId: 'm1',
    text: 'Some assistant message with enough length to verify.',
  })

  assert.match(rendered, /not reachable/i, 'the user must be told the engine is unavailable')
  assert.doesNotMatch(rendered, /\bSUPPORTED\b/, 'no verdict may be invented client-side')
})

test('E2E: the settings dashboard reads live store stats, not hardcoded numbers', async () => {
  const { host } = bootHost({ judgeQuote: 'the new line opened on 12 March 2024' })

  // Verify something first so the graph is genuinely non-empty.
  const verified = await host.call('verify', { text: 'The new transit line opened on 12 March 2024.' })
  assert.equal(verified.ok, true)

  const stats = await host.call('stats', {})
  assert.equal(stats.ok, true)
  assert.ok(stats.claims >= 1, 'the dashboard must observe the claim that was just stored')
  assert.equal(stats.persistent, false, 'an in-memory store must not be reported as persistent')

  // And the same claim is recallable through the browser-facing RPC.
  const recalled = await host.call('recall', { query: 'transit line opened' })
  assert.equal(recalled.ok, true)
  assert.ok(recalled.hits.length >= 1, 'prior findings must be retrievable from the UI')
})

test('E2E: an empty message is refused rather than verified into nothing', async () => {
  const { host } = bootHost({ judgeQuote: 'irrelevant' })
  const out = await host.call('verify', { text: '' })
  assert.equal(out.ok, false)
  assert.equal(out.error, 'empty-text')
})
