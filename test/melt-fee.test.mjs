// Must come first: coco pulls in @noble, which needs TextEncoder at module scope.
import '../lib/polyfills.mjs'
import test from 'brittle'
import { meltFeasibility } from '../lib/manager.mjs'

// coco swaps before melting once the selected proofs reach 11/10 of what the melt needs,
// and builds that swap to send the whole selected amount — so the mint's per-input fee
// lands on top. The melt can only work if some selection fits in
// [total + fee, total × 11/10), which needs total > 10 × fee.

test('a mint that charges nothing per input never blocks a melt', (t) => {
  for (const total of [1, 4, 21, 1000]) {
    t.ok(meltFeasibility(total, 0).possible, `${total} sat is fine with no input fee`)
  }
})

test('the floor at 100 ppk matches what the mint actually does', (t) => {
  // These three are not theory: each was tried against testnut, which charges 100 ppk.
  t.absent(meltFeasibility(4, 100).possible, '4 sat total — failed live')
  t.absent(meltFeasibility(10, 100).possible, '10 sat total — failed live')
  t.ok(meltFeasibility(20, 100).possible, '20 sat total — paid live')

  // The boundary either side of the floor.
  t.absent(meltFeasibility(10, 100).possible)
  t.ok(meltFeasibility(11, 100).possible)
  t.is(meltFeasibility(4, 100).floor, 11)
  t.is(meltFeasibility(4, 100).fee, 1, 'one input already costs a whole sat')
})

test('a heavier fee raises the floor', (t) => {
  // 2000 ppk is 2 sat per proof, so the melt has to be worth more than 20.
  t.is(meltFeasibility(1, 2000).fee, 2)
  t.is(meltFeasibility(1, 2000).floor, 21)
  t.absent(meltFeasibility(20, 2000).possible)
  t.ok(meltFeasibility(21, 2000).possible)
})

test('a fee below one sat still rounds up to one', (t) => {
  // NUT-02 rounds the total fee up, so any non-zero ppk costs at least 1 for one proof.
  t.is(meltFeasibility(1, 1).fee, 1)
  t.is(meltFeasibility(1, 50).floor, 11)
})
