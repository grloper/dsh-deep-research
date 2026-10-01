import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorQuote, admitCitations, Verdict } from '../lib/anchor.js'
import { verifyText } from '../lib/verify.js'

const source = 'During the annual audit the company reported that total revenue increased by 42 million dollars after completing the acquisition of its largest regional competitor in Europe.'
const changed = source.replace('42', '91')

test('high token overlap does not admit a changed quantity by default', () => {
  assert.equal(anchorQuote(changed, source, { allowFuzzy: true }).kind, 'FUZZY')
  assert.equal(anchorQuote(changed, source).ok, false)
})

test('citation admission stays strict even when fuzzy search is requested', () => {
  const report = admitCitations([{ docId: 'd1', quote: changed }], [{ id: 'd1', text: source }], { allowFuzzy: true })
  assert.equal(report.admitted.length, 0)
  assert.equal(report.rejected.length, 1)
})

test('a judge cannot support a claim using a quantity-altered approximate quote', async () => {
  const report = await verifyText('The revenue increased by 91 million dollars.', {
    atomize: async (text) => [{ id: 'c1', text }],
    gather: async () => [{ id: 'd1', text: source }],
    judge: async () => ({ verdict: Verdict.SUPPORTED, quote: changed, confidence: 1 }),
  })
  assert.equal(report.claims[0].citations.length, 0)
  assert.equal(report.claims[0].verdict, Verdict.UNVERIFIED)
})
