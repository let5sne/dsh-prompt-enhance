/**
 * Host half of the prompt-enhance bundle.
 *
 * The browser half seats one star button in `conversation.input.right`, which
 * renders immediately left of the model selector in the composer tool row. The
 * button posts the current draft here; this half rewrites it with the profile's
 * default model (`agentDefaultModel`) and returns the enhanced plain text.
 *
 * Transport: a package-owned HTTP route on the Harness web server. The page is
 * served from that same origin, so the Client half calls it with a relative
 * `fetch` and needs no Remote codegen, credentials, or extra packages.
 *
 * The route is loopback-only in practice (the Web GUI binds a local address),
 * rejects cross-origin browser calls, caps the request body, and answers JSON.
 */

/** Exact path of the package-owned JSON endpoint. */
const ENHANCE_PATH = '/dsh-prompt-enhance/enhance'

/** Largest accepted request body; a draft is a few kilobytes of text. */
const MAX_BODY_BYTES = 16 * 1024

/** Longest draft accepted for one rewrite. */
const MAX_DRAFT_CHARS = 6000

/** Wall-clock ceiling for one model call. */
const TIMEOUT_MS = 45_000

/** Required Host services; the row stays inactive without them. */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/** The rewriting instruction: one system prompt, no user-visible text. */
const SYSTEM_PROMPT = [
  '你是一名提示词工程师。用户会给你一段草稿输入，请把它改写成一条更清晰、更具体、可直接执行的提示词。',
  '',
  '要求：',
  '1. 保留用户原本的目标、约束和语气；不要新增用户没有表达的需求，也不要删除用户明确写出的条件。',
  '2. 补全缺失的关键要素：背景、目标、执行步骤、约束条件、期望输出格式。',
  '3. 结构化但不啰嗦：用短段落或要点表达，总长度不超过原文的三倍。',
  '4. 使用与草稿相同的语言输出（中文草稿用中文，英文草稿用英文）。',
  '5. 只输出改写后的提示词正文：不要解释、不要前后缀说明、不要引号或代码块围栏。',
].join('\n')

/** Write one JSON response. */
function sendJson(res, status, body) {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Read the whole request body, refusing anything above `limit` bytes. */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body is too large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) {
    const error = new Error('request body is empty')
    error.code = 'BODY_EMPTY'
    throw error
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Whether a browser call may use the route. A missing Origin is allowed for
 * non-browser callers on the loopback interface; a present Origin must name the
 * same host the request addressed.
 */
function originAllowed(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  return originHost === host
}

/**
 * Collect the model's visible text from one stream.
 * @param stream - the `ctx.llm.stream` chunk iterable.
 * @returns the concatenated text deltas.
 */
async function collectText(stream) {
  let text = ''
  for await (const chunk of stream) {
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    }
  }
  return text
}

/**
 * Rewrite one draft with the profile's default model.
 * @param ctx - the Host plugin context.
 * @param draft - the draft text from the composer.
 * @returns the enhanced plain text.
 */
async function enhance(ctx, draft) {
  const llm = ctx.get('llm')
  const defaults = ctx.get('agentDefaultModel')
  if (llm === undefined || defaults === undefined) {
    throw Object.assign(new Error('the model service is not available in this profile'), { code: 'NO_LLM' })
  }
  const selection = defaults.currentSelection()
  if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string' || selection.provider === '' || selection.model === '') {
    throw Object.assign(new Error('no default model is configured; choose one in Settings → Models'), { code: 'NO_MODEL' })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, TIMEOUT_MS)
  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
        ? { reasoningEffort: selection.reasoningEffort }
        : {},
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: draft }] }],
      temperature: 0.3,
      signal: controller.signal,
    })
    const text = await collectText(stream)
    if (text.trim() === '') {
      throw Object.assign(new Error('the model returned an empty prompt'), { code: 'EMPTY' })
    }
    return text.trim()
  } catch (failure) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error('the model call timed out'), { code: 'TIMEOUT' })
    }
    throw failure
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Answer one enhancement request.
 * @param ctx - the Host plugin context.
 * @param req - the incoming request.
 * @param res - the outgoing response.
 */
async function handle(ctx, req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { allow: 'POST, OPTIONS' })
    res.end()
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'use POST with a JSON body' })
    return
  }
  if (!originAllowed(req)) {
    sendJson(res, 403, { error: 'cross-origin call rejected' })
    return
  }

  let draft
  try {
    const body = await readBody(req, MAX_BODY_BYTES)
    const parsed = JSON.parse(body)
    const text = parsed !== null && typeof parsed === 'object' ? parsed.text : undefined
    if (typeof text !== 'string' || text.trim() === '') {
      sendJson(res, 400, { error: 'the body needs a non-empty "text" string' })
      return
    }
    if (text.length > MAX_DRAFT_CHARS) {
      sendJson(res, 413, { error: `the draft is longer than ${MAX_DRAFT_CHARS} characters` })
      return
    }
    draft = text
  } catch (failure) {
    const code = failure !== null && typeof failure === 'object' ? failure.code : undefined
    const status = code === 'BODY_TOO_LARGE' ? 413 : 400
    sendJson(res, status, { error: failure instanceof Error ? failure.message : 'invalid request body' })
    return
  }

  try {
    const text = await enhance(ctx, draft)
    sendJson(res, 200, { text })
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : 'the model call failed'
    sendJson(res, 502, { error: message })
  }
}

/**
 * Activate the Host half.
 * @param ctx - the Cordis context for this plugin row.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ENHANCE_PATH,
      handler: (req, res) => { void handle(ctx, req, res) },
    }),
    'prompt-enhance: JSON route',
  )
}