/**
 * Document-store semantics.
 *
 * These tests pin the store to the WeChat Cloud Database behaviour the shared
 * domain modules were written against. If one of them fails, the shared code is
 * running on a store that no longer matches its assumptions — which would show up
 * as a corrupted roster, not as an obvious error.
 */

import { describe, expect, it } from 'vitest'

import { CMD, command as _ } from '../src/db/command.js'
import { applyPatch, DocumentNotFoundError } from '../src/db/store.js'
import { store } from './helpers.js'

/** A correctly-tagged command carrying an operator the store does not implement. */
const unsupportedCommand = (op) => ({ [CMD]: true, op, value: 'x' })

const events = () => store.collection('events')

describe('documents', () => {
  it('round-trips a document and fills in _id', async () => {
    await events()
      .doc('e1')
      .set({ data: { title: 'Sat', capacity: 12 } })
    const { data } = await events().doc('e1').get()
    expect(data._id).toBe('e1')
    expect(data.title).toBe('Sat')
  })

  it('throws a recognisable error for a missing document', async () => {
    // The seam's getOrNull relies on this to return null instead of throwing.
    await expect(events().doc('nope').get()).rejects.toBeInstanceOf(DocumentNotFoundError)
  })

  it('replaces the whole document on set', async () => {
    await events()
      .doc('e1')
      .set({ data: { a: 1, b: 2 } })
    await events()
      .doc('e1')
      .set({ data: { a: 9 } })
    const { data } = await events().doc('e1').get()
    expect(data).toEqual({ _id: 'e1', a: 9 })
  })

  it('reports whether remove deleted anything', async () => {
    await events().doc('e1').set({ data: {} })
    expect(await events().doc('e1').remove()).toEqual({ deleted: 1 })
    expect(await events().doc('e1').remove()).toEqual({ deleted: 0 })
  })

  it('refuses a blank id rather than addressing the wrong row', async () => {
    expect(() => events().doc('')).toThrow(/requires an id/)
  })

  it('generates an id on add when none is given', async () => {
    const { _id } = await store.collection('clubs').add({ data: { name: 'Club' } })
    expect(_id).toMatch(/^d_[0-9a-f]{20}$/)
  })
})

describe('updates', () => {
  it('increments a top-level counter', async () => {
    await events()
      .doc('e1')
      .set({ data: { roster_count: 3 } })
    await events()
      .doc('e1')
      .update({ data: { roster_count: _.inc(2) } })
    expect((await events().doc('e1').get()).data.roster_count).toBe(5)
  })

  it('increments a nested field addressed by a dotted key', async () => {
    // Gender buckets are updated this way: 'roster_by_gender.male': _.inc(1)
    await events()
      .doc('e1')
      .set({ data: { roster_by_gender: { male: 1, female: 2 } } })
    await events()
      .doc('e1')
      .update({ data: { 'roster_by_gender.male': _.inc(3) } })
    const { data } = await events().doc('e1').get()
    expect(data.roster_by_gender).toEqual({ male: 4, female: 2 })
  })

  it('decrements with a negative increment', async () => {
    await events()
      .doc('e1')
      .set({ data: { roster_count: 4 } })
    await events()
      .doc('e1')
      .update({ data: { roster_count: _.inc(-1) } })
    expect((await events().doc('e1').get()).data.roster_count).toBe(3)
  })

  it('appends with push, treating a missing field as an empty array', async () => {
    await events().doc('e1').set({ data: {} })
    await events()
      .doc('e1')
      .update({ data: { venue_ids: _.push(['v1']) } })
    await events()
      .doc('e1')
      .update({ data: { venue_ids: _.push(['v2']) } })
    expect((await events().doc('e1').get()).data.venue_ids).toEqual(['v1', 'v2'])
  })

  it('leaves untouched fields alone', async () => {
    await events()
      .doc('e1')
      .set({ data: { a: 1, keep: 'me' } })
    await events()
      .doc('e1')
      .update({ data: { a: 2 } })
    expect((await events().doc('e1').get()).data.keep).toBe('me')
  })

  it('refuses to update a missing document', async () => {
    await expect(
      events()
        .doc('ghost')
        .update({ data: { a: 1 } })
    ).rejects.toBeInstanceOf(DocumentNotFoundError)
  })

  it('creates intermediate objects for a dotted key', () => {
    expect(applyPatch({}, { 'x.y': _.inc(3) })).toEqual({ x: { y: 3 } })
  })

  it('rejects an unsupported update command rather than writing something wrong', () => {
    expect(() => applyPatch({}, { a: unsupportedCommand('multiply') })).toThrow(
      /unsupported update command/
    )
  })

  it('treats a plain object that merely looks like a command as data', async () => {
    // Command sentinels are tagged with a symbol, so user data shaped like
    // { op, value } is stored verbatim instead of being executed.
    const lookalike = { op: 'inc', value: 5 }
    await events()
      .doc('e1')
      .set({ data: { note: lookalike } })
    expect((await events().doc('e1').get()).data.note).toEqual(lookalike)
  })
})

describe('queries', () => {
  const seed = async () => {
    await events()
      .doc('e1')
      .set({
        data: { lifecycle: 'ACTIVE', end_at: 1000, club_id: 'c1', start_at: 5, title: 'b' },
      })
    await events()
      .doc('e2')
      .set({
        data: { lifecycle: 'ACTIVE', end_at: 3000, club_id: 'c2', start_at: 3, title: 'a' },
      })
    await events()
      .doc('e3')
      .set({
        data: { lifecycle: 'CANCELLED', end_at: 4000, club_id: 'c1', start_at: 1, title: 'c' },
      })
    await events()
      .doc('e4')
      .set({ data: { lifecycle: 'ACTIVE', end_at: 50, club_id: null, start_at: 9, title: 'd' } })
  }

  it('combines equality, gt and in as a conjunction', async () => {
    await seed()
    const { data } = await events()
      .where({ lifecycle: 'ACTIVE', end_at: _.gt(500), club_id: _.in(['c1', 'c2']) })
      .orderBy('start_at', 'asc')
      .get()
    expect(data.map((d) => d._id)).toEqual(['e2', 'e1'])
  })

  it('orders numbers numerically, not as text', async () => {
    // 9 before 100: a lexical sort would put 100 first and silently mis-order
    // the waitlist, which is ordered by queued_at.
    await store
      .collection('signups')
      .doc('s1')
      .set({ data: { queued_at: 9 } })
    await store
      .collection('signups')
      .doc('s2')
      .set({ data: { queued_at: 100 } })
    const { data } = await store.collection('signups').orderBy('queued_at', 'asc').get()
    expect(data.map((d) => d.queued_at)).toEqual([9, 100])
  })

  it('orders descending', async () => {
    await seed()
    const { data } = await events().orderBy('end_at', 'desc').get()
    expect(data.map((d) => d.end_at)).toEqual([4000, 3000, 1000, 50])
  })

  it('matches nothing for an empty in list', async () => {
    await seed()
    const { data } = await events()
      .where({ club_id: _.in([]) })
      .get()
    expect(data).toEqual([])
  })

  it('looks up by _id through the primary key', async () => {
    await seed()
    const { data } = await events()
      .where({ _id: _.in(['e1', 'e3']) })
      .get()
    expect(data.map((d) => d._id).sort()).toEqual(['e1', 'e3'])
  })

  it('matches an explicit null', async () => {
    await seed()
    const { data } = await events().where({ club_id: null }).get()
    expect(data.map((d) => d._id)).toEqual(['e4'])
  })

  it('compares an array field by equality, not by containment', async () => {
    // jsonb `@>` is subset containment, so a naive equality compiled to `@>`
    // would match ['a','b'] when asked for ['a']. Nothing in the domain queries
    // an array field today; this keeps that from silently returning extra rows if
    // something starts to.
    await store
      .collection('clubs')
      .doc('c1')
      .set({ data: { venue_ids: ['a', 'b'] } })
    await store
      .collection('clubs')
      .doc('c2')
      .set({ data: { venue_ids: ['a'] } })

    const { data } = await store
      .collection('clubs')
      .where({ venue_ids: ['a'] })
      .get()
    expect(data.map((d) => d._id)).toEqual(['c2'])
  })

  it('compares an object field by equality, not by containment', async () => {
    await events()
      .doc('e5')
      .set({ data: { roster_by_gender: { male: 1, female: 2 } } })
    await events()
      .doc('e6')
      .set({ data: { roster_by_gender: { male: 1 } } })

    const { data } = await events()
      .where({ roster_by_gender: { male: 1 } })
      .get()
    expect(data.map((d) => d._id)).toEqual(['e6'])
  })

  it('applies limit', async () => {
    await seed()
    const { data } = await events().where({ lifecycle: 'ACTIVE' }).limit(2).get()
    expect(data).toHaveLength(2)
  })

  it('projects fields, always keeping _id', async () => {
    await seed()
    const { data } = await events().where({ _id: 'e1' }).field({ title: true }).get()
    expect(Object.keys(data[0]).sort()).toEqual(['_id', 'title'])
  })

  it('counts matches', async () => {
    await seed()
    expect(await events().where({ lifecycle: 'ACTIVE' }).count()).toEqual({ total: 3 })
  })

  it('supports or within a field', async () => {
    await seed()
    const { data } = await events()
      .where({ lifecycle: _.or('CANCELLED', 'DRAFT') })
      .get()
    expect(data.map((d) => d._id)).toEqual(['e3'])
  })

  it('rejects an unsupported query command loudly', async () => {
    await expect(
      events()
        .where({ a: unsupportedCommand('regex') })
        .get()
    ).rejects.toThrow(/unsupported query command/)
  })

  it('rejects an unknown collection name', () => {
    expect(() => store.collection('not_a_collection')).toThrow(/unknown collection/)
  })
})

describe('transactions', () => {
  it('commits work atomically', async () => {
    await events()
      .doc('e1')
      .set({ data: { roster_count: 0 } })
    await store.runTransaction(async (tx) => {
      await tx
        .collection('events')
        .doc('e1')
        .update({ data: { roster_count: _.inc(1) } })
    })
    expect((await events().doc('e1').get()).data.roster_count).toBe(1)
  })

  it('rolls everything back when the body throws', async () => {
    await events()
      .doc('e1')
      .set({ data: { roster_count: 0 } })
    await expect(
      store.runTransaction(async (tx) => {
        await tx
          .collection('events')
          .doc('e1')
          .update({ data: { roster_count: _.inc(5) } })
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect((await events().doc('e1').get()).data.roster_count).toBe(0)
  })

  it('refuses queries inside a transaction, matching Cloud DB', async () => {
    // Cloud DB cannot query inside a transaction, which is why waitlist promotion
    // is optimistic. Allowing it here would let the shared code drift into
    // depending on something the WeChat deployment cannot do.
    await expect(
      store.runTransaction(async (tx) => {
        await tx.collection('events').where({ a: 1 }).get()
      })
    ).rejects.toThrow(/not supported inside a transaction/)
  })

  it('serialises concurrent counter updates with row locks', async () => {
    await events()
      .doc('e1')
      .set({ data: { roster_count: 0 } })
    const bump = () =>
      store.runTransaction(async (tx) => {
        const { data } = await tx.collection('events').doc('e1').get()
        await new Promise((resolve) => setTimeout(resolve, 25)) // widen the window
        await tx
          .collection('events')
          .doc('e1')
          .update({ data: { roster_count: data.roster_count + 1 } })
      })

    await Promise.all([bump(), bump(), bump(), bump(), bump()])
    // Without FOR UPDATE on the read this lands below 5: a lost update.
    expect((await events().doc('e1').get()).data.roster_count).toBe(5)
  })
})
