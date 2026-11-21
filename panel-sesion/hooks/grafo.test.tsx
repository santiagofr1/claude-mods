import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'panel-sesion',
  component: 'Pane',
  requestId: 'panel-sesion',
  props: { title: 'Session', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const GIT = { raiz: '/r', rama: 'main', extra: '', staged: [], modificados: [], sinTrackear: [], conflictos: [], enMerge: false }
const c = (hash: string, padres: string[], asunto: string, refs: unknown[] = [], sinPush = false) =>
  ({ hash, padres, autor: 'yo', fecha: 0, asunto, refs, sinPush, archivos: 1, mas: 2, menos: 1 })
const HIST = [
  c('m2', ['m1', 'a2'], 'Merge feat/a', [{ t: 'head', n: 'main', sync: true }]),
  c('a2', ['a1'], 'a2', [{ t: 'rama', n: 'feat/a' }], true),
  c('a1', ['b'], 'a1'),
  c('m1', ['b'], 'm1', [{ t: 'remota', n: 'origin/old' }]),
  c('b', [], 'base', [{ t: 'tag', n: 'v1' }]),
]

test('el historial se dibuja con carriles, etiquetas y detalles', async ($, on) => {
  on('clock.now', () => ({ value: 3600_000 }))
  on('session.cwd', () => ({ value: '/r' }))
  on('state.get', (_, e, next) => {
    const k = (e as { key: string }).key
    if (k === 'git') return { value: { value: GIT } }
    if (k === 'historial') return { value: { value: HIST } }
    return next(e)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /HISTORY/ }))?.text).toContain('HISTORY')
    expect((await ui.find({ type: 'Text', text: /Merge feat\/a/ }))?.text).toContain('main')
    expect((await ui.find({ type: 'Text', text: /hover a commit/ }))).toBeTruthy()
    await ui.unmount()
  }
})
