window.__ModuleLoader__.load({
	id: '@let5sne/dsh-prompt-enhance',
	factory(require) {
		const React = require('react')
		const h = React.createElement

		/** Locale namespace owned by this package. */
		const NS = 'prompt-enhance'
		/** Package-owned Host route, served from the page's own origin. */
		const ENDPOINT = '/dsh-prompt-enhance/enhance'
		/** Slot this package seats: the composer tool row, just left of the model selector. */
		const SLOT = 'conversation.input.right'

		/** Component-local stylesheet; a rendered `style` element leaves with the component. */
		const CSS = `
.dsh-pe-host{position:relative;display:inline-flex;align-items:center;flex:none}
.dsh-pe-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dsh-pe-button:hover:not(:disabled){background:color-mix(in srgb,currentColor 12%,transparent);color:var(--dsw-alias-label-primary)}
.dsh-pe-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-pe-button:disabled{opacity:.4;cursor:default}
.dsh-pe-button[data-busy="true"]{color:var(--dsw-alias-brand-primary);cursor:progress}
.dsh-pe-button[data-pending="true"]{color:var(--dsw-alias-brand-primary)}
.dsh-pe-action{width:auto;min-height:28px;padding:0 6px;font-size:12px}
.dsh-pe-spin{animation:dsh-pe-rotate .9s linear infinite}
.dsh-pe-message{position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);max-width:240px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.4;white-space:normal;box-shadow:0 4px 14px rgba(0,0,0,.18);z-index:20;pointer-events:none}
.dsh-pe-message[data-kind="pending"]{color:var(--dsw-alias-label-secondary)}
@keyframes dsh-pe-rotate{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-pe-spin{animation-duration:2s}}
`

		/** The five-point star the request asks for; plain geometry, no third-party artwork. */
		const STAR_POINTS = '12,2.8 14.29,8.85 20.75,9.16 15.71,13.21 17.41,19.44 12,15.9 6.59,19.44 8.29,13.21 3.25,9.16 9.71,8.85'

		/** Compact star control; `pending` marks a finished rewrite waiting to be inserted. */
		function Star({ pending }) {
			return h('svg', {
				viewBox: '0 0 24 24',
				width: 18,
				height: 18,
				'aria-hidden': true,
				focusable: false,
				style: { display: 'block' },
			}, h('polygon', {
				points: STAR_POINTS,
				fill: pending ? 'currentColor' : 'none',
				stroke: 'currentColor',
				strokeWidth: 1.6,
				strokeLinejoin: 'round',
			}))
		}

		/** Busy indicator drawn in the same 18px box. */
		function Spinner() {
			return h('svg', {
				className: 'dsh-pe-spin',
				viewBox: '0 0 24 24',
				width: 18,
				height: 18,
				'aria-hidden': true,
				focusable: false,
				style: { display: 'block' },
			},
			h('circle', {
				cx: 12, cy: 12, r: 8, fill: 'none',
				stroke: 'currentColor', strokeWidth: 2, strokeOpacity: 0.26,
			}),
			h('path', {
				d: 'M12 4a8 8 0 0 1 8 8',
				fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
			}))
		}

		/**
		 * Star button for the composer tool row.
		 * Reads the draft through the Session input hook, rewrites it on the Host,
		 * and replaces the draft with the result. When the draft changed while the
		 * model was answering, the result is held until the next click instead of
		 * overwriting the newer text.
		 */
		function PromptEnhance(props) {
			const useInput = props.useInput
			const inputActions = props.inputActions
			const locked = props.locked === true
			const t = props.t
			const draft = useInput((state) => state.draft)
			const phase = useInput((state) => state.phase)

			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState('')
			const [pending, setPending] = React.useState(null)
			const draftRef = React.useRef(draft)
			const aliveRef = React.useRef(true)
			const errorTimer = React.useRef(undefined)
			// The active controller is also a synchronous gate and request identity.
			const requestRef = React.useRef(null)
			const writableRef = React.useRef(false)
			draftRef.current = draft
			writableRef.current = !locked && phase === 'plain'

			React.useEffect(() => {
				aliveRef.current = true
				return () => {
					aliveRef.current = false
					const request = requestRef.current
					requestRef.current = null
					request?.abort()
					if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
					errorTimer.current = undefined
				}
			}, [])

			const fail = (message) => {
				if (!aliveRef.current) return
				setError(message)
				if (errorTimer.current !== undefined) clearTimeout(errorTimer.current)
				errorTimer.current = setTimeout(() => {
					errorTimer.current = undefined
					if (aliveRef.current) setError('')
				}, 8000)
			}

			const cancel = () => {
				const request = requestRef.current
				if (request === null) return
				requestRef.current = null
				request.abort()
				if (aliveRef.current) setBusy(false)
			}

			const run = async () => {
				if (!aliveRef.current || requestRef.current !== null || !writableRef.current) return
				const source = draftRef.current
				if (typeof source !== 'string' || source.trim() === '') return
				// Match the Host's JavaScript string length (UTF-16 code units).
				if (source.length > 6000) {
					fail(t('tooLong'))
					return
				}
				const request = new AbortController()
				requestRef.current = request
				const isCurrent = () => aliveRef.current && requestRef.current === request && !request.signal.aborted
				if (errorTimer.current !== undefined) {
					clearTimeout(errorTimer.current)
					errorTimer.current = undefined
				}
				setError('')
				setPending(null)
				setBusy(true)
				try {
					const response = await fetch(ENDPOINT, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ text: source }),
						signal: request.signal,
					})
					if (!isCurrent()) return
					const payload = await response.json().catch(() => null)
					const text = payload !== null && typeof payload === 'object' && typeof payload.text === 'string'
						? payload.text.trim()
						: ''
					if (!response.ok || text === '') {
						throw new Error(payload !== null && typeof payload === 'object' && typeof payload.error === 'string' && payload.error !== ''
							? payload.error
							: `HTTP ${response.status}`)
					}
					if (!isCurrent()) return
					if (writableRef.current && draftRef.current === source) {
						inputActions.setDraft(text)
						setPending(null)
					} else {
						setPending({ text })
					}
				} catch (failure) {
					if (!isCurrent() || failure?.name === 'AbortError') return
					fail(failure instanceof Error ? failure.message : String(failure))
				} finally {
					// A cancelled request must never clear a newer request's busy state.
					if (requestRef.current === request) {
						requestRef.current = null
						if (aliveRef.current) setBusy(false)
					}
				}
			}

			const insert = () => {
				if (pending === null || !aliveRef.current || !writableRef.current) return
				inputActions.setDraft(pending.text)
				setPending(null)
				setError('')
			}

			const onClick = () => {
				if (!aliveRef.current || requestRef.current !== null || !writableRef.current) return
				if (pending !== null) {
					insert()
					return
				}
				void run()
			}

			const empty = typeof draft !== 'string' || draft.trim() === ''
			const blocked = locked || busy || phase !== 'plain'
			const disabled = busy || blocked || (empty && pending === null)
			const label = pending !== null ? t('insert') : t('enhance')

			return h('span', { className: 'dsh-pe-host' },
				h('style', null, CSS),
				h('button', {
					type: 'button',
					className: 'dsh-pe-button',
					'aria-label': label,
					title: label,
					disabled,
					'aria-busy': busy,
					'data-busy': busy ? 'true' : undefined,
					'data-pending': pending !== null ? 'true' : undefined,
					onMouseDown: (event) => { event.preventDefault() },
					onClick: onClick,
				}, busy ? h(Spinner) : h(Star, { pending: pending !== null })),
				busy || pending !== null ? h('button', {
					type: 'button',
					className: 'dsh-pe-button dsh-pe-action',
					'aria-label': busy ? t('cancel') : t('discard'),
					title: busy ? t('cancel') : t('discard'),
					onClick: busy ? cancel : () => { setPending(null) },
				}, busy ? t('cancel') : t('discard')) : null,
				error !== '' ? h('span', { className: 'dsh-pe-message', role: 'alert', title: error }, error) : null,
				pending !== null && error === '' ? h('span', { className: 'dsh-pe-message', 'data-kind': 'pending', role: 'status' }, t('pending')) : null)
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, {
					en: {
						enhance: 'Enhance prompt',
						insert: 'Replace the draft with the enhanced prompt',
						pending: 'Result saved — click the star to replace the draft, or discard',
						discard: 'Discard result',
						cancel: 'Cancel',
						tooLong: 'Shorten the prompt to 6000 characters or fewer (some emoji count as two).',
					},
					zh: {
						enhance: '增强提示词',
						insert: '用增强结果替换草稿',
						pending: '结果已暂存，点击星标替换草稿，或丢弃结果',
						discard: '丢弃结果',
						cancel: '取消',
						tooLong: '提示词过长，请缩短至 6000 字符以内（部分表情按两个字符计）。',
					},
				}), 'prompt-enhance: locale')

				ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
					name: SLOT,
					id: 'prompt-enhance',
					order: 20,
					locale: NS,
				}, PromptEnhance)), 'prompt-enhance: composer control')
			},
		}
	},
})