import { describe, expect, it } from 'vitest'
import { DEFAULT_PRICE_TABLE, estimateArkTokens, estimateCost, unitPrice, type PriceTable } from '../src/prices.ts'

const table: PriceTable = {
  currency: 'CNY',
  pricedAt: '2026-10-16',
  source: 'test',
  rows: [
    { providerId: 'ark', modelId: 'm1', unit: 'token', pricePerUnit: 0.1 },
    { providerId: 'ark', modelId: '', unit: 'token', pricePerUnit: 0.01 },
    { providerId: '', modelId: '', unit: 'token', pricePerUnit: 0.001 },
    { providerId: '', modelId: '', unit: 'second', pricePerUnit: 0.5 },
  ],
}

describe('unitPrice', () => {
  it('prefers an exact provider/model row, then provider-wide, then the global default', () => {
    expect(unitPrice(table, 'ark', 'm1', 'token')).toBe(0.1)
    expect(unitPrice(table, 'ark', 'm2', 'token')).toBe(0.01)
    expect(unitPrice(table, 'mm', 'm', 'token')).toBe(0.001)
  })

  it('matches by unit, so a token row never prices seconds', () => {
    expect(unitPrice(table, 'ark', 'm1', 'second')).toBe(0.5)
  })

  it('returns null when no row prices the unit, and skips non-positive rows', () => {
    const none: PriceTable = { currency: 'CNY', pricedAt: '', source: '', rows: [{ providerId: '', modelId: '', unit: 'second', pricePerUnit: 0 }] }
    expect(unitPrice(none, 'a', 'b', 'second')).toBeNull()
  })
})

describe('estimateCost', () => {
  it('multiplies tokens by the token price', () => {
    expect(estimateCost(table, { tokens: 100, outputSeconds: null, fields: {} }, 'ark', 'm1')).toEqual({ amount: 10, unit: 'token', usage: 100 })
  })

  it('multiplies output seconds by the second price', () => {
    expect(estimateCost(table, { tokens: null, outputSeconds: 5, fields: {} }, 'mm', 'm')).toEqual({ amount: 2.5, unit: 'second', usage: 5 })
  })

  it('is null for absent usage, and null when the unit has no price row', () => {
    expect(estimateCost(table, null, 'ark', 'm1')).toBeNull()
    const noSecond: PriceTable = { currency: 'CNY', pricedAt: '', source: '', rows: [] }
    expect(estimateCost(noSecond, { tokens: null, outputSeconds: 5, fields: {} }, 'mm', 'm')).toBeNull()
  })
})

describe('estimateArkTokens', () => {
  it('matches the two reverse-engineered reference points', () => {
    // 480p 16:9, 4 s → 864×496×97÷1024 = 40594 (DESIGN §7.1)
    expect(estimateArkTokens('480p', '16:9', 4)).toBe(40594)
    // 720p 16:9, 5 s → 1280×720×121÷1024 = 108900 (DESIGN §16.5)
    expect(estimateArkTokens('720p', '16:9', 5)).toBe(108900)
  })

  it('swaps width/height for 9:16 and uses the short side for 1:1', () => {
    expect(estimateArkTokens('480p', '9:16', 4)).toBe(40594)
    expect(estimateArkTokens('720p', '1:1', 5)).toBe(Math.floor((720 * 720 * 121) / 1024))
  })

  it('refuses geometry it cannot estimate', () => {
    expect(estimateArkTokens('720p', '4:3', 5)).toBeNull()
    expect(estimateArkTokens(null, '16:9', 4)).toBeNull()
    expect(estimateArkTokens('720p', '16:9', null)).toBeNull()
  })
})

describe('DEFAULT_PRICE_TABLE', () => {
  it('prices tokens and seconds, with a currency and a priced-at date', () => {
    expect(DEFAULT_PRICE_TABLE.currency).toBe('CNY')
    expect(DEFAULT_PRICE_TABLE.pricedAt.length).toBeGreaterThan(0)
    expect(unitPrice(DEFAULT_PRICE_TABLE, 'ark', 'm', 'token')).not.toBeNull()
    expect(unitPrice(DEFAULT_PRICE_TABLE, 'mm', 'm', 'second')).not.toBeNull()
  })
})
