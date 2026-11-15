import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { apply } from '../index.js'

const success = async function* () { yield { type: 'text-delta', text: ' enhanced ' }; yield { type: 'finish', reason: { kind: 'stop' } } }
function route(stream = success) {
  let registered
  const calls = []
  apply({
    effect(fn) { fn() },
    webServer: { register(value) { registered = value; return () => {} } },
    get(name) { return name === 'llm' ? { stream(options) { calls.push(options); return stream(options) } } : { currentSelection: () => ({ provider: 'provider', model: 'model', reasoningEffort: 'high' }) } },
  })
  assert.equal(registered.kind, 'exact')
  assert.equal(registered.path, '/dsh-prompt-enhance/enhance')
  return { handler: registered.handler, calls }
}
function request(handler, { body = JSON.stringify({ text: 'draft' }), headers = {}, encrypted = false, method = 'POST' } = {}) {
  const req = Readable.from([Buffer.from(body)])
  req.method = method
  req.headers = { host: 'localhost:3080', 'content-type': 'application/json', ...headers }
  req.socket = { encrypted }
  req.complete = true
  const res = new EventEmitter()
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = status => { assert.equal(res.destroyed, false); res.status = status }
  let resolve
  const done = new Promise(r => { resolve = r })
  res.end = payload => { assert.equal(res.destroyed, false); res.writableEnded = true; res.body = payload ? JSON.parse(payload) : undefined; resolve(res) }
  const task = handler(req, res)
  return { req, res, done, task }
}

test('normal path preserves selection and response protocol', async () => {
  const { handler, calls } = route()
  const { done } = request(handler)
  assert.deepEqual((await done).body, { text: 'enhanced' })
  assert.equal(calls[0].provider, 'provider')
  assert.equal(calls[0].model, 'model')
  assert.equal(calls[0].reasoningEffort, 'high')
  assert.equal(calls[0].signal.aborted, false)
})

test('6000 UTF16 units accept Chinese, escaped JSON and astral pairs', async () => {
  for (const body of [JSON.stringify({ text: '汉'.repeat(6000) }), '{"text":"' + '\\u6c49'.repeat(6000) + '"}', JSON.stringify({ text: '😀'.repeat(3000) })]) {
    assert.equal((await request(route().handler, { body }).done).status, 200)
  }
  for (const text of ['汉'.repeat(6001), '😀'.repeat(3001)]) {
    assert.equal((await request(route().handler, { body: JSON.stringify({ text }) }).done).status, 413)
  }
})

test('body boundary is 64KiB independent of draft length', async () => {
  const body = JSON.stringify({ text: 'ok' })
  for (const [bytes, status] of [[65536, 200], [65537, 413]]) {
    assert.equal((await request(route().handler, { body: body.padEnd(bytes) }).done).status, status)
  }
})

test('valid loopback hosts and matching origins', async () => {
  for (const host of ['localhost:3080', '127.0.0.1:3080', '127.255.1.2:3080', '[::1]:3080', '[0:0:0:0:0:0:0:1]:3080']) {
    assert.equal((await request(route().handler, { headers: { host, origin: `http://${host}` } }).done).status, 200)
  }
  assert.equal((await request(route().handler, { encrypted: true, headers: { origin: 'https://localhost:3080' } }).done).status, 200)
})

test('rejects illegal Host even without Origin and before OPTIONS', async () => {
  for (const host of [undefined, '', 'evil.test:3080', '127.0.0.999', '127.1', '2130706433', '0x7f000001', '127.0.0.1.evil', 'localhost@evil', 'localhost:99999', 'localhost:', 'localhost/path', ' localhost', '[::2]', '[::ffff:127.0.0.1]']) {
    for (const method of ['POST', 'OPTIONS']) {
      const { handler, calls } = route()
      assert.equal((await request(handler, { headers: { host }, method }).done).status, 403, String(host))
      assert.equal(calls.length, 0)
    }
  }
})

test('rejects malformed, foreign and mismatched scheme Origin; ignores forwarded headers', async () => {
  for (const origin of ['', 'null', 'ftp://localhost:3080', 'https://localhost:3080', 'http://evil.test:3080', 'http://localhost:3081', 'http://user@localhost:3080', 'http://localhost:3080/path', 'http://localhost:3080?x', 'http://localhost:3080#x', 'http://localhost:3080\\\\path', 'http://localhost:']) {
    assert.equal((await request(route().handler, { headers: { origin, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.test:3080' } }).done).status, 403, origin)
  }
  assert.equal((await request(route().handler, { headers: { host: 'evil.test', origin: 'http://evil.test', 'x-forwarded-host': 'localhost:3080' } }).done).status, 403)
})

test('requires application/json and permits charset', async () => {
  for (const type of [undefined, '', 'text/plain', 'application/jsonp']) {
    assert.equal((await request(route().handler, { headers: { 'content-type': type } }).done).status, 415)
  }
  assert.equal((await request(route().handler, { headers: { 'content-type': 'application/json; charset=utf-8' } }).done).status, 200)
})

test('invalid JSON and empty input retain error protocol', async () => {
  for (const body of ['', '{', 'null', '{}', '{"text":" "}']) {
    const res = await request(route().handler, { body }).done
    assert.equal(res.status, 400)
    assert.equal(typeof res.body.error, 'string')
  }
})

test('error and aborted finish discard partial text and preserve failure message', async () => {
  for (const kind of ['error', 'aborted']) {
    const { handler } = route(async function* () {
      yield { type: 'text-delta', text: 'partial' }
      yield { type: 'finish', reason: { kind, failure: { code: 'PROVIDER_FAILURE', message: 'provider refused' } } }
    })
    const res = await request(handler).done
    assert.equal(res.status, 502)
    assert.deepEqual(res.body, { error: 'provider refused' })
  }
})

test('real HTTP normal request close does not cancel, early response close aborts model', async t => {
  let mode = 'normal'
  let start
  let finish
  let activeSignal
  const started = () => new Promise(resolve => { start = resolve })
  const finished = () => new Promise(resolve => { finish = resolve })
  const { handler } = route(async function* ({ signal }) {
    activeSignal = signal
    start()
    try {
      if (mode === 'normal') {
        await nextTurn()
        assert.equal(signal.aborted, false)
        yield { type: 'text-delta', text: 'ok' }
      } else {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } }
      }
    } finally { finish() }
  })
  let serverReq, serverRes
  const server = http.createServer((req, res) => { serverReq = req; serverRes = res; handler(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const send = () => http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/dsh-prompt-enhance/enhance', method: 'POST', headers: { 'content-type': 'application/json' } })
  let begin = started(), end = finished()
  const normal = send()
  const response = new Promise((resolve, reject) => { normal.on('response', res => { res.resume(); res.on('end', resolve) }); normal.on('error', reject) })
  normal.end('{"text":"draft"}')
  await begin; await end; await response
  assert.equal(activeSignal.aborted, false)
  mode = 'cancel'
  begin = started(); end = finished()
  const cancelled = send()
  cancelled.on('error', () => {})
  cancelled.end('{"text":"draft"}')
  await begin
  cancelled.destroy()
  let watchdog
  try {
    await Promise.race([end, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('model did not abort')), 1000) })])
  } finally { clearTimeout(watchdog) }
  await nextTurn()
  assert.equal(activeSignal.aborted, true)
  assert.equal(serverReq.listenerCount('aborted'), 0)
  assert.equal(serverRes.listenerCount('close'), 0)
})

test('real HTTP oversized upload returns JSON 413; interrupted body never starts model', async t => {
  const { handler, calls } = route()
  let entered
  let handled
  const server = http.createServer((req, res) => {
    entered?.()
    handler(req, res).finally(() => handled?.())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const send = () => http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', headers: { 'content-type': 'application/json' } })
  const oversized = send()
  const result = new Promise((resolve, reject) => {
    oversized.on('error', reject)
    oversized.on('response', async res => {
      let body = ''
      for await (const chunk of res) body += chunk
      resolve({ status: res.statusCode, body: JSON.parse(body) })
    })
  })
  oversized.end(JSON.stringify({ text: 'ok' }).padEnd(65537))
  const response = await result
  assert.equal(response.status, 413)
  assert.equal(typeof response.body.error, 'string')
  const began = new Promise(resolve => { entered = resolve })
  const done = new Promise(resolve => { handled = resolve })
  const interrupted = send()
  interrupted.on('error', () => {})
  interrupted.write('{"text":"unfinished')
  await began
  interrupted.destroy()
  await done
  assert.equal(calls.length, 0)
})

test('disconnect cancellation is distinct from timeout and cleans up listeners', async () => {
  for (const event of ['aborted', 'close', 'response-close']) {
    const { handler, calls } = route(async function* ({ signal }) {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      throw new Error('adapter abort')
    })
    const { req, res, done, task } = request(handler)
    await nextTurn()
    if (event === 'response-close') {
      res.destroyed = true
      res.emit('close')
    } else {
      req.complete = false
      req.emit(event)
    }
    await task
    assert.equal(calls[0].signal.aborted, true)
    assert.equal(calls[0].signal.reason.code, 'CANCELLED')
    assert.equal(req.listenerCount('aborted'), 0)
    assert.equal(res.listenerCount('close'), 0)
    if (event === 'response-close') assert.equal(res.writableEnded, false)
    else assert.deepEqual((await done).body, { error: 'the client disconnected' })
  }
})

test('model timeout aborts and successful model call clears timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const normal = route()
  const completed = request(normal.handler)
  await completed.task
  t.mock.timers.tick(45000)
  assert.equal(normal.calls[0].signal.aborted, false)
  const stalled = route(async function* ({ signal }) {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    yield { type: 'text-delta', text: 'partial after abort' }
  })
  const pending = request(stalled.handler)
  await nextTurn()
  t.mock.timers.tick(45000)
  await pending.task
  assert.equal(stalled.calls[0].signal.reason.code, 'TIMEOUT')
  assert.deepEqual((await pending.done).body, { error: 'the model call timed out' })
  assert.equal(pending.req.listenerCount('aborted'), 0)
  assert.equal(pending.res.listenerCount('close'), 0)
})
