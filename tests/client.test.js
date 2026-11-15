import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Unit behavior harness, not React DOM, a real browser, or a visual/E2E test.
// State setters are batched until render() so same-render reentrancy is exercised.
function harness({ draft = 'original', locale = 'en' } = {}) {
  const hooks = []
  const cleanups = []
  const requests = []
  const writes = []
  const timers = new Map()
  let index = 0, Component, strings, tree, mounted = true, afterUnmount = 0
  const state = { draft, phase: 'plain' }
  const props = {
    locked: false,
    useInput: select => select(state),
    inputActions: { setDraft(text) { writes.push(text); state.draft = text } },
    t: key => strings[locale][key],
  }
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      const i = index++
      if (!(i in hooks)) hooks[i] = initial
      return [hooks[i], value => { if (!mounted) afterUnmount++; hooks[i] = value }]
    },
    useRef(initial) {
      const i = index++
      if (!(i in hooks)) hooks[i] = { current: initial }
      return hooks[i]
    },
    useEffect(effect) {
      const i = index++
      if (!(i in hooks)) { hooks[i] = true; cleanups.push(effect()) }
    },
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load({ factory }) {
      factory(name => { assert.equal(name, 'react'); return React }).apply({
        effect: fn => fn(),
        locale: { register(ns, value) { strings = value } },
        slots: {
          inject(name, fn) { assert.equal(name, 'conversation.input.right'); return fn() },
          register(options, component) { Component = component },
        },
      })
    } } },
    AbortController,
    setTimeout(fn) { const id = {}; timers.set(id, fn); return id },
    clearTimeout(id) { timers.delete(id) },
    fetch(url, options) {
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      requests.push({ url, options, resolve, reject })
      return promise
    },
  })
  const render = () => { index = 0; tree = Component(props); return tree }
  const all = (node = tree) => node && typeof node === 'object' ? [node, ...node.children.flatMap(all)] : []
  const button = key => all().find(n => n.type === 'button' && n.props['aria-label'] === strings[locale][key])
  const click = key => { const node = button(key); assert.ok(node, `button ${key} exists`); assert.equal(node.props.type, 'button'); assert.notEqual(node.props.disabled, true); node.props.onClick() }
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); render() }
  const respond = async (i, text = 'enhanced') => { requests[i].resolve({ ok: true, status: 200, json: async () => ({ text }) }); await settle() }
  render()
  return { state, props, requests, writes, render, button, click, settle, respond, strings, timers,
    alerts: () => all().filter(n => n.props.role === 'alert'),
    unmount() { mounted = false; cleanups.forEach(fn => fn?.()) },
    get afterUnmount() { return afterUnmount },
  }
}

test('normal enhancement keeps endpoint/JSON protocol and trims result', async () => {
  const h = harness(); h.click('enhance'); h.render()
  assert.equal(h.button('enhance').props.disabled, true)
  assert.equal(h.requests[0].url, '/dsh-prompt-enhance/enhance')
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { text: 'original' })
  await h.respond(0, ' enhanced ')
  assert.deepEqual(h.writes, ['enhanced'])
})

test('changed draft stages result, explicit discard preserves draft and permits retry', async () => {
  const h = harness(); h.click('enhance'); h.state.draft = 'new draft'; h.render(); await h.respond(0)
  assert.deepEqual(h.writes, []); assert.ok(h.button('insert'))
  h.click('discard'); h.render()
  assert.equal(h.state.draft, 'new draft'); assert.equal(h.button('insert'), undefined)
  h.click('enhance'); await h.respond(1, 'second'); assert.deepEqual(h.writes, ['second'])
})

test('pending star still confirms replacement', async () => {
  const h = harness(); h.click('enhance'); h.state.draft = 'changed'; h.render(); await h.respond(0)
  h.click('insert'); h.render(); assert.deepEqual(h.writes, ['enhanced'])
})

test('cancel aborts and late successful response cannot write or show an error', async () => {
  const h = harness(); h.click('enhance'); h.render(); h.click('cancel'); h.render()
  assert.equal(h.requests[0].options.signal.aborted, true)
  await h.respond(0); assert.deepEqual(h.writes, []); assert.equal(h.alerts().length, 0)
  assert.equal(h.button('enhance').props.disabled, false)
})

for (const outcome of ['resolve', 'reject']) test(`old ${outcome} after cancel cannot clear new request busy state`, async () => {
  const h = harness(); h.click('enhance'); h.render(); h.click('cancel'); h.render(); h.click('enhance'); h.render()
  if (outcome === 'resolve') await h.respond(0, 'stale')
  else { h.requests[0].reject(new Error('old failure')); await h.settle() }
  assert.equal(h.button('enhance').props.disabled, true); assert.ok(h.button('cancel'))
  assert.equal(h.alerts().length, 0); assert.deepEqual(h.writes, [])
  await h.respond(1, 'current'); assert.deepEqual(h.writes, ['current'])
})

test('unmount aborts request and ignores callbacks', async () => {
  const h = harness(); h.click('enhance'); h.unmount()
  assert.equal(h.requests[0].options.signal.aborted, true)
  await h.respond(0); assert.deepEqual(h.writes, []); assert.equal(h.afterUnmount, 0)
})

test('cancel while JSON is pending ignores its late body after a new request', async () => {
  const h = harness(); h.click('enhance')
  let resolveBody
  h.requests[0].resolve({ ok: true, json: () => new Promise(resolve => { resolveBody = resolve }) })
  await h.settle(); h.click('cancel'); h.render(); h.click('enhance'); h.render()
  resolveBody({ text: 'stale body' }); await h.settle()
  assert.deepEqual(h.writes, []); assert.equal(h.button('enhance').props.disabled, true)
  await h.respond(1); assert.deepEqual(h.writes, ['enhanced'])
})

test('cancelled fetch rejection stays silent', async () => {
  const h = harness(); h.click('enhance'); h.render(); h.click('cancel')
  h.requests[0].reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  await h.settle(); assert.equal(h.alerts().length, 0); assert.deepEqual(h.writes, [])
})

test('empty draft does not request enhancement', () => {
  const h = harness({ draft: '  ' }); assert.equal(h.button('enhance').props.disabled, true)
  h.button('enhance').props.onClick(); assert.equal(h.requests.length, 0)
})

test('synchronous double activation starts only one request', async () => {
  const h = harness(); const click = h.button('enhance').props.onClick
  click(); click(); assert.equal(h.requests.length, 1); await h.respond(0)
})

for (const change of ['locked', 'phase']) test(`response while ${change} changes remains pending until unlocked`, async () => {
  const h = harness(); h.click('enhance')
  if (change === 'locked') h.props.locked = true
  else h.state.phase = 'sending'
  h.render(); await h.respond(0)
  assert.deepEqual(h.writes, []); assert.ok(h.button('insert'))
  h.button('insert').props.onClick(); assert.deepEqual(h.writes, [])
  h.props.locked = false; h.state.phase = 'plain'; h.render(); h.click('insert')
  assert.deepEqual(h.writes, ['enhanced'])
})

test('stale event callback checks current locked state before starting', () => {
  const h = harness(); const click = h.button('enhance').props.onClick
  h.props.locked = true; h.render(); click(); assert.equal(h.requests.length, 0)
})

for (const locale of ['en', 'zh']) test(`local UTF-16 limit and boundary (${locale})`, async () => {
  const h = harness({ draft: '😀'.repeat(3000) + 'a', locale }); h.click('enhance'); h.render()
  assert.equal(h.requests.length, 0); assert.equal(h.alerts().length, 1)
  assert.match(h.alerts()[0].children.join(''), /6000/)
  h.state.draft = '😀'.repeat(3000); h.render(); h.click('enhance'); await h.respond(0)
  assert.deepEqual(h.writes, ['enhanced']); assert.equal(h.alerts().length, 0)
})
