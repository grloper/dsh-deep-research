/**
 * @file Tests for the DSH plugin surface and its defensive adapters.
 *
 * Critique Pass 5 said the plugin must survive a moving, pre-1.0 host API.
 * These tests assert that: no service, partial services, and hostile service
 * shapes must all degrade rather than throw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  hashId,
  inject,
  makeAtomizer,
  makeDecomposer,
  makeFetch,
  makeJudge,
  makeSearch,
  name,
  stripHtml,
} from '../lib/index.js'

test('plugin exposes a name and soft injections only', () => {
  assert.equal(name, 'dsh-deep-research')
  assert.ok(inject.optional.includes('tools'))
  assert.ok(!Array.isArray(inject), 'injections must be declared optional, not required')
})

test('stripHtml removes scripts, styles and tags', () => {
  const html =
    '<html><head><style>.a{color:red}</style><script>alert(1)</script></head>' +
    '<body><nav>menu</nav><p>Real content here.</p><p>More &amp; more.</p><footer>x</footer></body></html>'
  const text = stripHtml(html)
  assert.ok(text.includes('Real content here.'))
  assert.ok(text.includes('More & more.'))
  assert.ok(!text.includes('alert'))
  assert.ok(!text.includes('color:red'))
})

test('stripHtml decodes common entities and preserves paragraph breaks', () => {
  const t = stripHtml('<p>a &lt; b</p><p>c &quot;d&quot;</p>')
  assert.ok(t.includes('a < b'))
  assert.ok(t.includes('c "d"'))
})

test('apply does not throw with a completely empty context', () => {
  assert.doesNotThrow(() => apply({}, { storePath: ':memory:' }))
})

test('apply does not throw with a null-ish context', () => {
  assert.doesNotThrow(() => apply(undefined, { storePath: ':memory:' }))
})

test('makeSearch returns null when no web service exists', () => {
  assert.equal(makeSearch({}), null)
  assert.equal(makeSearch({ web: {} }), null)
})

test('makeSearch adapts both sources and results shapes', async () => {
  const a = makeSearch({ web: { search: async () => ({ sources: [{ url: 'u1', title: 't' }] }) } })
  assert.deepEqual(await a('q'), [{ url: 'u1', title: 't', snippet: undefined }])

  const b = makeSearch({ web: { search: async () => ({ results: [{ url: 'u2', content: 'c' }] }) } })
  assert.deepEqual(await b('q'), [{ url: 'u2', title: undefined, snippet: 'c' }])
})

test('makeFetch falls back when the web service throws', async () => {
  const f = makeFetch({
    web: {
      fetch: async () => {
        throw new Error('service down')
      },
    },
  })
  // Falls through to global fetch, which will fail for this bogus URL and
  // must yield null rather than propagate.
  const r = await f('http://127.0.0.1:1/definitely-not-listening')
  assert.equal(r, null)
})

test('makeFetch prefers the host web service when it works', async () => {
  const f = makeFetch({ web: { fetch: async () => ({ content: 'host provided text', status: 200 }) } })
  const r = await f('https://example.com')
  assert.equal(r.text, 'host provided text')
})

test('makeAtomizer and makeJudge return null without an llm service', () => {
  assert.equal(makeAtomizer({}), null)
  assert.equal(makeJudge({}), null)
  assert.equal(makeAtomizer({ llm: {} }), null)
})

test('atomizer parses a JSON array from a noisy model response', async () => {
  const atomize = makeAtomizer({
    llm: {
      generate: async () => 'Sure! Here you go:\n["Claim one about a thing.","Claim two about another."]\nDone.',
    },
  })
  const claims = await atomize('irrelevant')
  assert.equal(claims.length, 2)
  assert.equal(claims[0].text, 'Claim one about a thing.')
  assert.equal(claims[0].id, 'c1')
})

test('atomizer falls back to heuristics on malformed model output', async () => {
  const atomize = makeAtomizer({ llm: { generate: async () => 'no json at all here' } })
  const claims = await atomize('The company reported revenue of 42 million dollars in 2023.')
  assert.ok(claims.length >= 1, 'must fall back rather than return nothing')
})

test('atomizer falls back when the model throws', async () => {
  const atomize = makeAtomizer({
    llm: {
      generate: async () => {
        throw new Error('rate limited')
      },
    },
  })
  const claims = await atomize('The agency confirmed that inspections resumed in March 2024.')
  assert.ok(Array.isArray(claims))
})

test('judge coerces an unknown verdict to NEUTRAL', async () => {
  const judge = makeJudge({
    llm: { generate: async () => '{"verdict":"TOTALLY_MADE_UP","quote":"x","score":0.9}' },
  })
  const r = await judge({ text: 'c' }, { text: 'doc' })
  assert.equal(r.verdict, 'NEUTRAL')
})

test('judge returns NEUTRAL when the model emits no JSON', async () => {
  const judge = makeJudge({ llm: { generate: async () => 'I cannot answer that.' } })
  const r = await judge({ text: 'c' }, { text: 'doc' })
  assert.equal(r.verdict, 'NEUTRAL')
  assert.equal(r.quote, '')
})

test('tools are registered when a tools service is present', () => {
  const registered = []
  const ctx = {
    tools: { register: (spec) => registered.push(spec.name) },
    on: () => {},
  }
  apply(ctx, { storePath: ':memory:' })
  assert.ok(registered.includes('verify_text'), 'verify_text must be registered')
  assert.ok(registered.includes('check_source'))
  assert.ok(registered.includes('compare_sources'))
  assert.ok(registered.includes('deep_research'), 'deep_research must be registered')
})

test('hashId is stable and collision-resistant enough for keys', () => {
  assert.equal(hashId('https://example.com/a'), hashId('https://example.com/a'))
  assert.notEqual(hashId('https://example.com/a'), hashId('https://example.com/b'))
  assert.match(hashId('anything'), /^[0-9a-z]+$/)
})

test('makeDecomposer is absent without an llm and parses JSON with one', async () => {
  assert.equal(makeDecomposer({}), undefined)
  const d = makeDecomposer({
    llm: { generate: async () => 'Here:\n["Sub question one here?","Sub question two here?"]' },
  })
  assert.deepEqual(await d('parent question'), ['Sub question one here?', 'Sub question two here?'])
})

test('makeDecomposer returns empty on malformed output rather than throwing', async () => {
  const d = makeDecomposer({ llm: { generate: async () => 'no json' } })
  assert.deepEqual(await d('q'), [])
})

test('deep_research tool runs end to end without network or llm', async () => {
  /** @type {any[]} */ const specs = []
  apply({ tools: { register: (s) => specs.push(s) }, on: () => {} }, { storePath: ':memory:' })
  const dr = specs.find((s) => s.name === 'deep_research')
  assert.ok(dr, 'deep_research must exist')
  const out = await dr.execute({ question: 'Does a test question resolve cleanly?', mode: 'quick' })
  assert.match(out, /Research trace/)
  assert.match(out, /Does a test question resolve/)
})

test('deep_research declares its mode enum', () => {
  /** @type {any[]} */ const specs = []
  apply({ tools: { register: (s) => specs.push(s) }, on: () => {} }, { storePath: ':memory:' })
  const dr = specs.find((s) => s.name === 'deep_research')
  assert.deepEqual(dr.parameters.mode.enum, ['quick', 'standard', 'deep', 'forensic'])
})

test('registration failure in the host does not break plugin load', () => {
  const ctx = {
    tools: {
      register: () => {
        throw new Error('host rejected the tool')
      },
    },
    on: () => {},
  }
  assert.doesNotThrow(() => apply(ctx, { storePath: ':memory:' }))
})

test('alternative host registration methods are supported', () => {
  const viaDefine = []
  apply({ tools: { define: (s) => viaDefine.push(s.name) }, on: () => {} }, { storePath: ':memory:' })
  assert.ok(viaDefine.length >= 1, 'tools.define should be used when register is absent')

  const viaAdd = []
  apply({ tools: { add: (s) => viaAdd.push(s.name) }, on: () => {} }, { storePath: ':memory:' })
  assert.ok(viaAdd.length >= 1, 'tools.add should be used as a last resort')
})

test('registered verify_text tool executes end to end', async () => {
  /** @type {any[]} */ const specs = []
  apply({ tools: { register: (s) => specs.push(s) }, on: () => {} }, { storePath: ':memory:' })
  const verify = specs.find((s) => s.name === 'verify_text')
  assert.ok(verify, 'verify_text must exist')
  const out = await verify.execute({ text: 'The company reported revenue of 42 million dollars in 2023.' })
  assert.match(out, /Verification report/)
})

test('verify_text tool handles empty input gracefully', async () => {
  /** @type {any[]} */ const specs = []
  apply({ tools: { register: (s) => specs.push(s) }, on: () => {} }, { storePath: ':memory:' })
  const verify = specs.find((s) => s.name === 'verify_text')
  const out = await verify.execute({ text: '' })
  assert.match(out, /No check-worthy/i)
})

test('every registered tool declares a name, description and parameters', () => {
  /** @type {any[]} */ const specs = []
  apply({ tools: { register: (s) => specs.push(s) }, on: () => {} }, { storePath: ':memory:' })
  for (const s of specs) {
    assert.ok(s.name, 'tool needs a name')
    assert.ok(s.description && s.description.length > 40, `${s.name} needs a real description`)
    assert.ok(s.parameters && typeof s.parameters === 'object')
    assert.equal(typeof s.execute, 'function')
  }
})
