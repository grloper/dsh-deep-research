/**
 * @file Integrity tests for the browser half.
 *
 * The production audit found that the client fabricated verdicts when the Host
 * was unreachable: it keyword-matched a few sentences, stamped them SUPPORTED,
 * and displayed hardcoded "0.0% phantom rate" KPIs. These tests exist so that
 * behaviour cannot come back — the client must render only what the Host proved,
 * and must say so plainly when the Host is unavailable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const rawSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Strip comments so these assertions test executable code, not prose. Comments
 * legitimately quote the removed values while explaining why they were removed.
 */
const source = rawSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

test('the client contains no fabricated-verdict heuristics', () => {
  // The old implementation keyed verdicts off a topic word list.
  assert.ok(
    !/leucine|mTOR|diaas|salmon|whey/i.test(source),
    'topic keyword list must not decide verdicts',
  )
  assert.ok(
    !/verdict:\s*isContradicted\s*\?/.test(source),
    'verdicts must come from the host engine, never from a regex over prose',
  )
})

test('the client does not hardcode phantom-rate or anchoring KPIs', () => {
  assert.ok(!/"0\.0%"/.test(source), 'phantom rate must be measured, not asserted')
  assert.ok(
    !/kestrel-kpi-num" \}, "100%"/.test(source),
    'anchoring percentage must be measured, not asserted',
  )
})

test('the client calls the host engine over the HTTP bridge and has no offline verdict fallback', () => {
  assert.ok(source.includes('kestrelCall("verify"'), 'must call the real host engine to verify')
  assert.ok(source.includes('kestrelGet("stats"'), 'settings must read real store stats')
  assert.ok(source.includes('/kestrel/api'), 'the same-origin API path must be targeted')
  assert.ok(
    /host engine is not reachable/i.test(source),
    'must surface an explicit unavailable state instead of guessing',
  )
})

test('the client reads message text from slot props before touching the DOM', () => {
  const fn = source.slice(source.indexOf('function readMessageText'))
  const propsAt = fn.indexOf('props.useChat')
  const domAt = fn.indexOf('btn.closest')
  assert.ok(propsAt > -1 && domAt > -1, 'both paths must exist')
  assert.ok(propsAt < domAt, 'slot props must be consulted before the rendered DOM')
})

test('the client keeps no module-level per-session state that could leak across reloads', () => {
  assert.ok(!/deepResearchModeState/.test(source), 'the old unbounded per-session map must be gone')
  assert.ok(source.includes('KESTREL_API_BASE'), 'all engine access goes through the bounded HTTP bridge')
})

test('the client uses no JSX and no bare imports, as the Cordis evaluator requires', () => {
  assert.ok(!/^\s*import\s/m.test(source), 'client code must not use ESM imports')
  assert.ok(!/<[A-Z][A-Za-z]*\s*\/?>/.test(source), 'client code must not use JSX')
})
