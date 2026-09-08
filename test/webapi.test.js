/**
 * @file Tests for the browser HTTP API registered by the host plugin.
 *
 * The browser UI reaches the engine through a same-origin /kestrel/api route on
 * the host webserver — DSH hands no `host` RPC global to client plugins. These
 * tests lock in that contract: route registration, JSON-only dispatch, and the
 * research/verify/stats payloads the UI renders.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, KESTREL_API_PATH, registerWebApi, Verdict } from '../lib/index.js'

/** Boot a host with a webServer double capturing the registered route. */
function bootHost({ judgeQuote, judgeVerdict = Verdict.SUPPORTED } = {}) {
  let route = null
  const effects = []
  const ctx = {
    tools: { register: () => () => {} },
    on: () => {},
    // Real Cordis runs effect bodies when the services they need are present.
    effect: (fn) => { fn(); return () => {} },
    webServer: {
      register: (spec) => { route = spec; return () => {} },
    },
    web: {
      search: async () => ({ sources: [{ url: 'https://transit.example.gov/opening', title: 'Line opening' }] }),
      fetch: async () => ({
        content:
          'The transit authority confirmed that the new line opened on 12 March 2024, ' +
          'serving an estimated 40,000 passengers on its first day of operation.',
        status: 200,
      }),
    },
    llm: {
      generate: async ({ prompt }) => {
        if (/Return ONLY a JSON array of strings/.test(prompt)) {
          return '["The new transit line opened on 12 March 2024."]'
        }
        return JSON.stringify({ verdict: judgeVerdict, quote: judgeQuote, score: 0.9 })
      },
    },
  }
  const result = apply(ctx, { storePath: ':memory:', maxSources: 2 })
  return { ctx, result, getRoute: () => route }
}

/** Drive one captured route handler with a fake Node request/response. */
function callRoute(handler, { method = 'GET', path = KESTREL_API_PATH, body } = {}) {
  const req = { method, url: path, headers: { host: 'localhost:3080' } }
  if (body !== undefined) {
    const chunks = [Buffer.from(JSON.stringify(body))]
    req.on = (event, cb) => {
      if (event === 'data') for (const c of chunks) cb(c)
      if (event === 'end') setTimeout(() => cb(), 0)
      if (event === 'error') { /* never fires */ }
    }
  } else {
    req.on = () => {}
  }
  return new Promise((resolve, reject) => {
    const res = {
      status: 0,
      body: '',
      writeHead(status, headers) { this.status = status },
      end(payload) {
        this.body = typeof payload === 'string' ? payload : String(payload)
        resolve({ status: this.status, json: JSON.parse(this.body || '{}') })
      },
    }
    handler(req, res).catch(reject)
  })
}

test('registerWebApi registers the /kestrel/api route when a webserver exists', () => {
  const { ctx, getRoute, result } = bootHost()
  assert.ok(registerWebApi(ctx, {
    deps: {},
    store: null,
    graph: null,
    research: { decompose: undefined, tribunal: {}, graph: undefined },
    capabilities: {},
    defaultMode: 'standard',
    log: { info() {}, warn() {} },
  }))
  const route = getRoute()
  assert.ok(route, 'route must be registered')
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, KESTREL_API_PATH)
  assert.equal(typeof route.handler, 'function')
  assert.equal(result.http, true)
})

test('registerWebApi returns false on hosts without a webserver', () => {
  const { ctx } = bootHost()
  ctx.webServer = undefined
  assert.equal(
    registerWebApi(ctx, {
      deps: {}, store: null, graph: null, research: {}, capabilities: {}, defaultMode: 'standard',
      log: { info() {}, warn() {} },
    }),
    false,
  )
})

test('apply() mounts the HTTP API and runs the real verify pipeline on POST /verify', async () => {
  const { getRoute } = bootHost({ judgeQuote: 'the new line opened on 12 March 2024' })
  const route = getRoute()
  assert.ok(route, 'apply() must register the route')

  const { status, json } = await callRoute(route.handler, {
    method: 'POST',
    path: `${KESTREL_API_PATH}/verify`,
    body: { text: 'The new transit line opened on 12 March 2024.' },
  })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.ok(Array.isArray(json.claims))
  assert.ok(json.claims.some((c) => c.verdict === Verdict.SUPPORTED), 'mechanically anchored claims surface')
})

test('POST /research returns a JSON report with findings and copyable markdown', async () => {
  const { getRoute } = bootHost({ judgeQuote: 'the new line opened on 12 March 2024' })
  const route = getRoute()

  const { status, json } = await callRoute(route.handler, {
    method: 'POST',
    path: `${KESTREL_API_PATH}/research`,
    body: { question: 'Did the new transit line open on 12 March 2024?', mode: 'quick' },
  })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.mode, 'quick')
  assert.ok(Array.isArray(json.findings))
  assert.match(json.summary, /sub-question/)
  assert.equal(typeof json.markdown, 'string')
  assert.ok(json.markdown.length > 0)
  // The whole payload must survive a JSON round-trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(json)), json)
})

test('POST /research refuses an empty question instead of inventing findings', async () => {
  const { getRoute } = bootHost()
  const { json } = await callRoute(getRoute().handler, {
    method: 'POST',
    path: `${KESTREL_API_PATH}/research`,
    body: { question: '   ' },
  })
  assert.equal(json.ok, false)
  assert.equal(json.error, 'empty-question')
  assert.deepEqual(json.findings, [])
})

test('GET /stats returns the settings-dashboard counters', async () => {
  const { getRoute } = bootHost()
  const { json } = await callRoute(getRoute().handler, { method: 'GET', path: `${KESTREL_API_PATH}/stats` })
  assert.equal(json.ok, true)
  assert.equal(typeof json.claims, 'number')
  assert.equal(typeof json.sources, 'number')
})

test('an unknown kestrel api method answers 404 JSON, never a stray page', async () => {
  const { getRoute } = bootHost()
  const { status, json } = await callRoute(getRoute().handler, { method: 'GET', path: `${KESTREL_API_PATH}/nope` })
  assert.equal(status, 404)
  assert.equal(json.ok, false)
})
