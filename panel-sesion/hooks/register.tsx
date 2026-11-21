import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Archivo, Cambio, Comando, Commit, CommitDetalle, GitAccion, GitArchivo, GitDetalle, GitInfo, Seleccion } from '../types'

const PANEL = 'panel-sesion'
const TITULO = 'Session'
const MAX_TXT = 12000
const ABRIR = { id: PANEL, title: TITULO, backgroundColor: 'transparent', rows: 1 } as const

const archivos = atom({ plugin: 'panel-sesion', key: 'archivos' } as const, [], { shape: 'archivos-2' })
const comandos = atom({ plugin: 'panel-sesion', key: 'comandos' } as const, [], { shape: 'comandos-2' })
const leidos = atom({ plugin: 'panel-sesion', key: 'leidos' } as const, 0)
const seleccion = atom({ plugin: 'panel-sesion', key: 'seleccion' } as const, null as Seleccion)
const vistos = atom({ plugin: 'panel-sesion', key: 'vistos' } as const, [] as string[])
const abiertos = atom({ plugin: 'panel-sesion', key: 'abiertos' } as const, [] as string[])
const git = atom({ plugin: 'panel-sesion', key: 'git' } as const, null as GitInfo | null)
const confirmar = atom({ plugin: 'panel-sesion', key: 'confirmar' } as const, null as string | null)
const accion = atom({ plugin: 'panel-sesion', key: 'accion' } as const, null as GitAccion)
const detalle = atom({ plugin: 'panel-sesion', key: 'detalle' } as const, null as GitDetalle)
const historial = atom({ plugin: 'panel-sesion', key: 'historial' } as const, [] as Commit[])
const detalleCommit = atom({ plugin: 'panel-sesion', key: 'detalleCommit' } as const, null as CommitDetalle)

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

// ───────────── utilidades ─────────────

function aPatch(hunks: readonly Hunk[]) {
  return hunks
    .map(h => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`)
    .join('\n')
}

function nuevoComoPatch(contenido: string) {
  const ls = contenido.replace(/\n$/, '').split('\n')
  return `@@ -0,0 +1,${ls.length} @@\n${ls.map(l => '+' + l).join('\n')}`
}

function cortar(t: string) {
  return t.length <= MAX_TXT ? t : t.slice(0, MAX_TXT) + `\n… (${t.length - MAX_TXT} more characters)`
}

function relativa(ruta: string, base: string) {
  if (ruta.startsWith(base + '/')) return ruta.slice(base.length + 1)
  const home = /^\/home\/[^/]+/.exec(base)?.[0]
  return home && ruta.startsWith(home + '/') ? '~' + ruta.slice(home.length) : ruta
}

function recortar(t: string, max: number) {
  const una = t.replace(/\s+/g, ' ').trim()
  return una.length <= max ? una : una.slice(0, Math.max(1, max - 1)) + '…'
}

function partes(ruta: string) {
  const i = ruta.lastIndexOf('/')
  return i < 0 ? { nombre: ruta, dir: '' } : { nombre: ruta.slice(i + 1), dir: ruta.slice(0, i) }
}

function lenguaje(ruta: string) {
  const ext = /\.([a-z0-9]+)$/i.exec(ruta)?.[1]?.toLowerCase()
  return ext === 'tsx' || ext === 'ts' ? 'typescript' : ext === 'js' || ext === 'jsx' ? 'javascript' : ext === 'py' ? 'python' : ext
}

function contar(patch: string) {
  let mas = 0
  let menos = 0
  for (const l of patch.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) continue
    if (l.startsWith('+')) mas++
    else if (l.startsWith('-')) menos++
  }
  return { mas, menos }
}

function stats(a: Archivo) {
  return a.cambios.reduce(
    (n, c) => { const s = contar(c.patch); return { mas: n.mas + s.mas, menos: n.menos + s.menos } },
    { mas: 0, menos: 0 },
  )
}

function hace(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')} ago`
}

function quitarComillas(r: string) {
  return r.startsWith('"') && r.endsWith('"') ? r.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : r
}

// Qué significa cada letra de git status
function letra(c: string) {
  return c === 'M' ? 'modified' : c === 'A' ? 'added' : c === 'D' ? 'deleted' : c === 'R' ? 'renamed' : c === 'C' ? 'copied' : c === 'U' ? 'conflict' : c
}

// ───────────── git ─────────────

let ocupado = false
let pendiente = false

async function refrescarGit($: EngineInterface) {
  if (ocupado) { pendiente = true; return }
  ocupado = true
  try {
    const cwd = await $.session.cwd()
    const raiz = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
    if (raiz.exitCode !== 0) { await update($, git, () => null); return }
    const r = raiz.stdout.trim()
    const st = await $.process.run(['git', 'status', '--porcelain=v1', '-b', '--untracked-files=all'], { cwd: r, timeoutMs: 10000 })
    if (st.exitCode !== 0) return
    const info: GitInfo = { raiz: r, rama: '', extra: '', staged: [], modificados: [], sinTrackear: [], conflictos: [], enMerge: false }
    for (const linea of st.stdout.split('\n')) {
      if (!linea) continue
      if (linea.startsWith('## ')) {
        const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(.+)\])?/.exec(linea)
        info.rama = m?.[1] ?? linea.slice(3)
        info.extra = (m?.[2] ?? '').replace('ahead', '↑').replace('behind', '↓')
        continue
      }
      const x = linea[0] ?? ' '
      const y = linea[1] ?? ' '
      let ruta = linea.slice(3)
      if (ruta.includes(' -> ')) ruta = ruta.split(' -> ')[1] ?? ruta
      ruta = quitarComillas(ruta)
      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { info.conflictos.push(ruta); continue }
      if (x === '?' && y === '?') { if (info.sinTrackear.length < 300) info.sinTrackear.push(ruta); continue }
      if (x !== ' ') info.staged.push({ ruta, x, y })
      if (y !== ' ') info.modificados.push({ ruta, x, y })
    }
    info.enMerge = (await $.process.run(['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: r, timeoutMs: 5000 })).exitCode === 0
    const [ns, nc] = await Promise.all([
      $.process.run(['git', 'diff', '--numstat'], { cwd: r, timeoutMs: 10000 }),
      $.process.run(['git', 'diff', '--cached', '--numstat'], { cwd: r, timeoutMs: 10000 }),
    ])
    const aplicar = (salida: string, lista: GitArchivo[]) => {
      for (const l of salida.split('\n')) {
        const [a, b, ...resto] = l.split('\t')
        const ruta = resto.join('\t')
        const f = lista.find(x => x.ruta === ruta)
        if (f && a !== undefined && b !== undefined) { f.mas = Number(a) || 0; f.menos = Number(b) || 0 }
      }
    }
    aplicar(ns.stdout, info.modificados)
    aplicar(nc.stdout, info.staged)
    await update($, git, () => info)
    await cargarHistorial($, r)
  } catch {
    // git no disponible: el panel sigue en modo sesión
  } finally {
    ocupado = false
    if (pendiente) { pendiente = false; void refrescarGit($) }
  }
}

async function cargarDetalle($: EngineInterface, raiz: string, ruta: string, sinTrackear: boolean) {
  const opts = { cwd: raiz, timeoutMs: 10000 }
  if (sinTrackear) {
    const d = await $.process.run(['git', 'diff', '--no-color', '--no-index', '--', '/dev/null', ruta], opts)
    await update($, detalle, () => ({ ruta, staged: '', trabajo: cortar(soloHunks(d.stdout)), nuevo: true }))
    return
  }
  const [s, w] = await Promise.all([
    $.process.run(['git', 'diff', '--no-color', '--cached', '--', ruta], opts),
    $.process.run(['git', 'diff', '--no-color', '--', ruta], opts),
  ])
  await update($, detalle, () => ({ ruta, staged: cortar(soloHunks(s.stdout)), trabajo: cortar(soloHunks(w.stdout)), nuevo: false }))
}

async function accionGit($: EngineInterface, raiz: string, args: string[]) {
  const r = await $.process.run(['git', ...args], { cwd: raiz, timeoutMs: 15000 })
  if (r.exitCode !== 0) $.ui.toast(`git ${args[0]}: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? 'failed'}`)
  await refrescarGit($)
}

// fetch / pull / push / commit: corre git sin pedir contraseñas por terminal y guarda el resultado
async function correrGit($: EngineInterface, raiz: string, nombre: string, args: string[]) {
  await update($, accion, () => ({ accion: nombre, estado: 'corre', texto: '' }))
  try {
    const r = await $.process.run(['git', ...args], {
      cwd: raiz,
      timeoutMs: 120000,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' },
    })
    const salida = `${r.stdout}\n${r.stderr}`.trim()
    const conflicto = /CONFLICT|Automatic merge failed|fix conflicts/i.test(salida)
    const estado: NonNullable<GitAccion>['estado'] = conflicto ? 'conflicto' : r.exitCode === 0 ? 'ok' : 'error'
    const texto = salida.split('\n').filter(Boolean).slice(-8).join('\n') || (estado === 'ok' ? 'done' : 'failed')
    await update($, accion, () => ({ accion: nombre, estado, texto }))
  } catch (err) {
    await update($, accion, () => ({ accion: nombre, estado: 'error', texto: String(err) }))
  }
  await refrescarGit($)
}

// Mensaje automático: Haiku lee el diff ya agregado y propone una línea, como el botón ✨ de VS Code
async function mensajeAuto($: EngineInterface, raiz: string) {
  const [stat, diff, log] = await Promise.all([
    $.process.run(['git', 'diff', '--cached', '--stat'], { cwd: raiz, timeoutMs: 15000 }),
    $.process.run(['git', 'diff', '--cached', '--no-color', '-U2'], { cwd: raiz, timeoutMs: 15000 }),
    $.process.run(['git', 'log', '-8', '--pretty=%s'], { cwd: raiz, timeoutMs: 5000 }),
  ])
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 80,
    system:
      'You write git commit messages. Reply with ONE line only, max 72 characters, imperative mood, no quotes, no trailing period. ' +
      'Match the language and style (e.g. conventional commits) of the recent messages if there are any.',
    prompt: `Recent commit messages:\n${log.stdout.trim() || '(none)'}\n\nChanged files:\n${stat.stdout.trim()}\n\nDiff:\n${diff.stdout.slice(0, 12000)}`,
  })
  const linea = r.isAnswered ? r.text.trim().split('\n')[0]?.replace(/^["'`]|["'`.]$/g, '').trim() : ''
  return linea || 'Update files'
}

async function push($: EngineInterface, g: GitInfo) {
  // Rama sin remoto todavía: la publica en origin
  const up = await $.process.run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: g.raiz, timeoutMs: 5000 })
  await correrGit($, g.raiz, 'push', up.exitCode === 0 ? ['push'] : ['push', '-u', 'origin', g.rama])
}

async function aGitignore($: EngineInterface, raiz: string, ruta: string) {
  const archivo = `${raiz}/.gitignore`
  const previo = (await $.fs.exists(archivo)) ? String(await $.fs.read(archivo)) : ''
  const linea = '/' + ruta
  if (previo.split('\n').some(l => l.trim() === linea)) return
  await $.fs.write(archivo, previo + (previo === '' || previo.endsWith('\n') ? '' : '\n') + linea + '\n')
  $.ui.toast(`${ruta} added to .gitignore`)
}

// El componente Code quiere solo los hunks (desde el primer @@)
function soloHunks(d: string) {
  const i = d.indexOf('\n@@')
  return i < 0 ? (d.startsWith('@@') ? d : '') : d.slice(i + 1).replace(/\n$/, '')
}

// ───────────── historial de ramas ─────────────

const MAX_COMMITS = 40
// Un color por carril, como el gráfico de VS Code
const COLORES = ['#4fc1ff', '#f97583', '#b392f0', '#85e89d', '#ffab70', '#f692ce', '#79b8ff', '#ffea7f']

type Celda = { ch: string; color?: string; bold?: boolean }
type FilaGrafo = { antes: Celda[] | null; nodo: Celda[]; despues: Celda[] | null; color: string }

async function cargarHistorial($: EngineInterface, raiz: string) {
  const opts = { cwd: raiz, timeoutMs: 10000 }
  const [log, remotos] = await Promise.all([
    $.process.run(['git', 'log', '--branches', '--remotes', '--tags', 'HEAD', '--topo-order', '-n', String(MAX_COMMITS),
      '--format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%D', '--shortstat'], opts),
    $.process.run(['git', 'remote'], opts),
  ])
  if (log.exitCode !== 0) { await update($, historial, () => []); return }
  // Sin remoto no tiene sentido marcar "sin pushear"
  let sinPush = new Set<string>()
  if (remotos.stdout.trim()) {
    const rl = await $.process.run(['git', 'rev-list', '--branches', '--not', '--remotes'], opts)
    sinPush = new Set(rl.stdout.split('\n').filter(Boolean))
  }
  const commits: Commit[] = []
  for (const reg of log.stdout.split('\x1e')) {
    if (!reg.trim()) continue
    const [cab = '', ...resto] = reg.split('\n')
    const [hash = '', padres = '', autor = '', fecha = '0', asunto = '', refs = ''] = cab.split('\x1f')
    const st = resto.join(' ')
    const c: Commit = {
      hash,
      padres: padres.split(' ').filter(Boolean),
      autor,
      fecha: Number(fecha) * 1000,
      asunto,
      refs: refs.split(', ').map(r => r.trim()).filter(r => r && r !== 'origin/HEAD' && !r.endsWith('/HEAD')),
      sinPush: sinPush.has(hash),
    }
    const n = /(\d+) files? changed/.exec(st)
    if (n) {
      c.archivos = Number(n[1])
      c.mas = Number(/(\d+) insertion/.exec(st)?.[1] ?? 0)
      c.menos = Number(/(\d+) deletion/.exec(st)?.[1] ?? 0)
    }
    commits.push(c)
  }
  await update($, historial, () => commits)
}

async function cargarCommit($: EngineInterface, raiz: string, hash: string) {
  const r = await $.process.run(['git', 'show', '--no-color', '--format=%B%x1e', hash], { cwd: raiz, timeoutMs: 15000 })
  const [cuerpo = '', diff = ''] = r.stdout.split('\x1e')
  const archivos = diff.split(/\n(?=diff --git )/).filter(b => b.startsWith('diff --git') || b.trim().startsWith('diff --git')).map(b => {
    const bloque = b.trim()
    const ruta = /^diff --git a\/.+? b\/(.+)$/m.exec(bloque)?.[1] ?? '?'
    return { ruta, patch: cortar(soloHunks(bloque)) }
  })
  await update($, detalleCommit, () => ({ hash, cuerpo: cuerpo.trim(), archivos: archivos.slice(0, 40) }))
}

// Arma los carriles: cada commit en su columna, con las uniones (antes) y las bifurcaciones (después)
function armarGrafo(commits: readonly Commit[]): FilaGrafo[] {
  const carriles: (string | null)[] = []
  const colorDe: string[] = []
  let siguiente = 0
  const nuevoColor = () => COLORES[siguiente++ % COLORES.length] ?? '#4fc1ff'
  const libre = () => {
    const i = carriles.indexOf(null)
    if (i >= 0) return i
    carriles.push(null)
    return carriles.length - 1
  }
  const vacia = (n: number): Celda[] => Array.from({ length: n * 2 }, () => ({ ch: ' ' }))
  // Une la columna `col` con cada destino con una línea horizontal
  const conectar = (fila: Celda[], col: number, destinos: { t: number; ch: string }[], sigue: boolean) => {
    let der = false
    let izq = false
    for (const { t, ch } of destinos) {
      const color = colorDe[t]
      const [a, b] = t > col ? [col, t] : [t, col]
      for (let x = a * 2 + 1; x < b * 2; x++) {
        const c = fila[x]
        fila[x] = { ch: c && c.ch === '│' ? '┼' : '─', color }
      }
      fila[t * 2] = { ch, color }
      if (t > col) der = true
      else izq = true
    }
    const ch = der && izq ? '┼' : der ? (sigue ? '├' : '╰') : sigue ? '┤' : '╯'
    fila[col * 2] = { ch, color: colorDe[col] }
  }

  const filas: FilaGrafo[] = []
  for (const c of commits) {
    let col = carriles.indexOf(c.hash)
    if (col < 0) {
      col = libre()
      carriles[col] = c.hash
      colorDe[col] = nuevoColor()
    }
    const antes = carriles.slice()
    const color = colorDe[col] ?? '#4fc1ff'

    // Ramas que terminan en este commit (salieron de acá): se juntan arriba del nodo
    const cierran = antes.flatMap((h, i) => (h === c.hash && i !== col ? [i] : []))
    let filaAntes: Celda[] | null = null
    if (cierran.length) {
      filaAntes = vacia(antes.length)
      antes.forEach((h, i) => { if (h) filaAntes![i * 2] = { ch: '│', color: colorDe[i] } })
      conectar(filaAntes, col, cierran.map(t => ({ t, ch: t > col ? '╯' : '╰' })), true)
      for (const i of cierran) carriles[i] = null
    }

    const nodo = vacia(antes.length)
    carriles.forEach((h, i) => { if (h) nodo[i * 2] = { ch: '│', color: colorDe[i] } })
    nodo[col * 2] = { ch: c.sinPush ? '○' : '●', color, bold: true }

    // Padres: el primero sigue en el carril, los demás (merge) abren o se unen a otro carril
    carriles[col] = c.padres[0] ?? null
    const abren: { t: number; ch: string }[] = []
    for (const p of c.padres.slice(1)) {
      let t = carriles.indexOf(p)
      if (t >= 0 && t !== col) abren.push({ t, ch: t > col ? '┤' : '├' })
      else {
        t = libre()
        carriles[t] = p
        colorDe[t] = nuevoColor()
        abren.push({ t, ch: t > col ? '╮' : '╭' })
      }
    }
    let filaDespues: Celda[] | null = null
    if (abren.length) {
      filaDespues = vacia(carriles.length)
      carriles.forEach((h, i) => { if (h) filaDespues![i * 2] = { ch: '│', color: colorDe[i] } })
      conectar(filaDespues, col, abren, carriles[col] !== null)
    }
    while (carriles.length && carriles[carriles.length - 1] === null) carriles.pop()
    filas.push({ antes: filaAntes, nodo, despues: filaDespues, color })
  }
  return filas
}

// Junta celdas seguidas del mismo color para dibujar menos nodos
function tramos(celdas: Celda[], ancho: number) {
  const out: Celda[] = []
  for (const c of celdas.slice(0, ancho)) {
    const u = out[out.length - 1]
    if (u && u.color === c.color && u.bold === c.bold) u.ch += c.ch
    else out.push({ ...c })
  }
  const largo = celdas.slice(0, ancho).length
  if (largo < ancho) out.push({ ch: ' '.repeat(ancho - largo) })
  return out
}

function haceFecha(ms: number, ahora: number) {
  const m = Math.max(0, Math.round((ahora - ms) / 60000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d` : `${Math.round(d / 30)}mo`
}

// ───────────── registro ─────────────

export const register: Register = on => {
  let reloj: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'panel', description: 'Show or hide the session side panel' })
    // Se abre solo si la última vez lo dejaste visible
    if ((await $.store.get('visible')) !== false) void $.ui.open(ABRIR)
    reloj?.cancel()
    reloj = $.clock.every(20_000, () => void refrescarGit($))
    void refrescarGit($)
    return next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    const abierto = (await $.ui.panes()).some(x => x.id === PANEL)
    if (abierto) {
      await $.store.set('visible', false)
      await $.ui.close({ id: PANEL })
      return { text: 'Session panel hidden. /panel to show it again.' }
    }
    await $.store.set('visible', true)
    await $.ui.open(ABRIR)
    void refrescarGit($)
    return { text: 'Session panel shown.' }
  })

  // Si lo cerrás con la cruz del panel, también queda oculto para las próximas sesiones
  on('ui.close', async ($, e, next) => {
    if (e.id === PANEL && e.origin.kind === 'person') await $.store.set('visible', false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void refrescarGit($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    if (e.tool === 'Read') {
      await update($, leidos, n => n + 1)
      return next(e)
    }

    if (e.tool === 'Edit' || e.tool === 'Write') {
      const ruta = e.file_path
      const ran = await next(e)
      if (ran.deny !== undefined) return ran
      const fallo = ran.isError === true
      let cambio: Cambio | undefined
      if (!fallo && ran.result) {
        const r = ran.result as { structuredPatch?: Hunk[]; content?: string; type?: string }
        const creado = e.tool === 'Write' && r.type === 'create'
        const patch = creado ? nuevoComoPatch(r.content ?? '') : aPatch(r.structuredPatch ?? [])
        if (patch) cambio = { patch: cortar(patch), nuevo: creado }
      }
      await update($, archivos, lista => {
        const previo = lista.find(a => a.ruta === ruta)
        const a: Archivo = {
          ruta,
          tipo: previo?.tipo === 'nuevo' || cambio?.nuevo ? 'nuevo' : 'edit',
          error: fallo,
          cambios: [...(previo?.cambios ?? []), ...(cambio ? [cambio] : [])].slice(-20),
        }
        return [...lista.filter(x => x.ruta !== ruta), a].slice(-60)
      })
      // un archivo que vuelve a cambiar deja de estar "visto"
      await update($, vistos, v => v.filter(x => x !== `a:${ruta}`))
      void refrescarGit($)
      return ran
    }

    if (e.tool === 'Bash') {
      const c: Comando = { id: e.tool_use_id, cmd: e.command, desc: e.description, estado: 'corre', t: await $.clock.now() }
      await update($, comandos, lista => [...lista, c].slice(-60))
      const ran = await next(e)
      const estado: Comando['estado'] = ran.deny !== undefined || ran.isError === true ? 'error' : 'ok'
      const r = (ran.result ?? {}) as { stdout?: string; stderr?: string }
      const salida = ran.deny ?? (r.stdout !== undefined ? r.stdout : ran.text) ?? ''
      const stderr = r.stderr ?? ''
      await update($, comandos, lista =>
        lista.map(x => (x.id === c.id ? { ...x, estado, salida: cortar(salida), stderr: cortar(stderr) } : x)),
      )
      void refrescarGit($)
      return ran
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    const { Box, Text, Button, Code, Input } = $.ui.resolve(e)
    const [lista, cmds, nLeidos, sel, vis, abiertas, g, det, cwd, ahora, conf, act, hist, detCommit] = await Promise.all([
      read($, archivos),
      read($, comandos),
      read($, leidos),
      read($, seleccion),
      read($, vistos),
      read($, abiertos),
      read($, git),
      read($, detalle),
      $.session.cwd(),
      $.clock.now(),
      read($, confirmar),
      read($, accion),
      read($, historial),
      read($, detalleCommit),
    ])
    const ancho = Math.max(24, e.props.bodyColumns)
    const visto = new Set(vis)
    const abierta = new Set(abiertas)

    const elegir = (s: Seleccion) => () => { void update($, confirmar, () => null); void update($, seleccion, () => s) }
    const marcar = (ids: string[]) => () => {
      void update($, vistos, v => [...new Set([...v, ...ids])])
      void update($, seleccion, () => null)
    }
    const desmarcar = (id: string) => () => void update($, vistos, v => v.filter(x => x !== id))
    const check = (id: string, esVisto: boolean) => (
      <Button key={`v-${id}`} onPress={esVisto ? desmarcar(id) : marcar([id])}>
        <Text color={esVisto ? 'subtle' : 'success'}>{esVisto ? '↺' : '✓'}</Text>
      </Button>
    )
    const alternar = (sec: string) => () =>
      void update($, abiertos, a => (a.includes(sec) ? a.filter(x => x !== sec) : [...a, sec]))
    const abrirGit = (ruta: string, sinTrack: boolean) => () => {
      if (!g) return
      void update($, detalle, () => null)
      void update($, confirmar, () => null)
      void update($, seleccion, () => ({ tipo: 'git', id: ruta }))
      void cargarDetalle($, g.raiz, ruta, sinTrack)
    }

    // Archivos que tocó Claude y que git ya cubre (dentro del repo)
    const enRepo = (ruta: string) => g !== null && (ruta === g.raiz || ruta.startsWith(g.raiz + '/'))

    const regla = (titulo: string, extra: string, color = 'claude') => (
      <Text>
        <Text color={color} bold>{titulo}</Text>
        <Text dimColor> {extra} </Text>
        <Text color="subtle">{'─'.repeat(Math.max(2, ancho - titulo.length - extra.length - 3))}</Text>
      </Text>
    )
    const chip = (texto: string, color: string) => (
      <Text backgroundColor={color} color="inverseText" bold>{` ${texto} `}</Text>
    )
    const plegable = (sec: string, texto: string, n: number) => (
      <Button key={`p-${sec}`} onPress={alternar(sec)}>
        <Text color="subtle">{abierta.has(sec) ? '▾ ' : '▸ '}{texto}{texto.startsWith(String(n)) ? '' : ` (${n})`}</Text>
      </Button>
    )
    const volverBtn = <Button key="volver" hotkey="b" onPress={elegir(null)}>back</Button>

    // ── Terminal angosta: una sola línea ──
    if (e.props.placement === 'inline') {
      const err = cmds.filter(c => c.estado === 'error' && !visto.has(`c:${c.id}`)).length
      const pend = cmds.filter(c => !visto.has(`c:${c.id}`)).length
      return (
        <Text wrap="truncate-end">
          <Text color="claude" bold>◆ </Text>
          {g ? (
            <Text>
              <Text bold>{partes(g.raiz).nombre} </Text>
              <Text color="claude">⎇ {g.rama}</Text>
              <Text dimColor>  </Text>
              <Text color="success">{g.staged.length}●</Text>
              <Text> </Text>
              <Text color="warning">{g.modificados.length}◐</Text>
              <Text dimColor> {g.sinTrackear.length}?</Text>
            </Text>
          ) : (
            <Text>
              <Text bold>{lista.filter(a => !visto.has(`a:${a.ruta}`)).length}</Text>
              <Text dimColor> files</Text>
            </Text>
          )}
          <Text dimColor> · {pend} cmds </Text>
          <Text color={err > 0 ? 'error' : 'subtle'}>{err}✗</Text>
          <Text dimColor>  (widen the terminal for details)</Text>
        </Text>
      )
    }

    // ── Commit: todo lo que cambió entra (lo ignorado por .gitignore queda afuera) ──
    if (sel?.tipo === 'commit' && g) {
      const todos = [
        ...g.staged.map(f => ({ ruta: f.ruta, marca: '●', color: 'success', mas: f.mas, menos: f.menos })),
        ...g.modificados.filter(f => !g.staged.some(x => x.ruta === f.ruta)).map(f => ({ ruta: f.ruta, marca: '◐', color: 'warning', mas: f.mas, menos: f.menos })),
        ...g.sinTrackear.map(r => ({ ruta: r, marca: '+', color: 'suggestion', mas: undefined as number | undefined, menos: undefined as number | undefined })),
      ]
      return (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="success" paddingX={1}>
            <Text>{chip('COMMIT', 'success')}<Text bold>  {todos.length} file{todos.length === 1 ? '' : 's'}</Text><Text dimColor>  ⎇ {g.rama}</Text></Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {todos.map(f => (
              <Text key={`cs-${f.ruta}`} wrap="truncate-end">
                <Text color={f.color} bold>{f.marca} </Text>{f.ruta}
                {f.mas ? <Text color="diffAdded">  +{f.mas}</Text> : null}
                {f.menos ? <Text color="diffRemoved"> −{f.menos}</Text> : null}
                {f.mas === undefined ? <Text dimColor>  new</Text> : null}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Input
              key="mensaje"
              label="Commit message"
              placeholder="leave empty + enter: ✨ auto message"
              submitLabel="commit"
              autoFocus
              onSubmit={msg => {
                const escrito = msg.trim()
                void update($, seleccion, () => null)
                void (async () => {
                  const add = await $.process.run(['git', 'add', '-A'], { cwd: g.raiz, timeoutMs: 30000 })
                  if (add.exitCode !== 0) {
                    await update($, accion, () => ({ accion: 'commit', estado: 'error', texto: (add.stderr || add.stdout).trim() }))
                    return
                  }
                  let m = escrito
                  if (!m) {
                    await update($, accion, () => ({ accion: 'commit', estado: 'corre', texto: '✨ writing a message…' }))
                    m = await mensajeAuto($, g.raiz).catch(() => 'Update files')
                  }
                  await correrGit($, g.raiz, 'commit', ['commit', '-m', m])
                  await update($, accion, a => (a && a.estado === 'ok' ? { ...a, texto: `✨ ${m}\n${a.texto}` } : a))
                })()
              }}
            />
          </Box>
          <Text dimColor>files you untracked or put in .gitignore are left out</Text>
          <Box marginTop={1}>{volverBtn}</Box>
        </Box>
      )
    }

    // ── Detalle: archivo de git ──
    if (sel?.tipo === 'git' && g) {
      const sinTrack = g.sinTrackear.includes(sel.id)
      const st = g.staged.find(x => x.ruta === sel.id)
      const mo = g.modificados.find(x => x.ruta === sel.id)
      const { nombre, dir } = partes(sel.id)
      const listo = det !== null && det.ruta === sel.id
      const s1 = listo ? contar(det.staged) : { mas: 0, menos: 0 }
      const s2 = listo ? contar(det.trabajo) : { mas: 0, menos: 0 }
      const etiqueta = sinTrack ? 'UNTRACKED' : st && mo ? 'PARTIAL' : st ? 'STAGED' : mo ? letra(mo.y).toUpperCase() : 'CLEAN'
      const color = sinTrack ? 'subtle' : st && !mo ? 'success' : 'warning'
      return (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column">
            <Text wrap="truncate-end">
              {chip(etiqueta, color)}
              <Text bold>  {nombre}</Text>
            </Text>
            {dir ? <Text dimColor wrap="truncate-end">{dir}</Text> : null}
            <Text>
              <Text color="diffAdded" bold>+{s1.mas + s2.mas}</Text>
              <Text dimColor> · </Text>
              <Text color="diffRemoved" bold>−{s1.menos + s2.menos}</Text>
              <Text dimColor>  ⎇ {g.rama}</Text>
            </Text>
          </Box>
          {!listo ? <Text dimColor>loading diff…</Text> : null}
          {listo && det.staged ? (
            <Box marginTop={1} flexDirection="column">
              {regla('● staged', 'ready to commit', 'success')}
              <Code source={det.staged} format="diff" path={sel.id} language={lenguaje(sel.id)} />
            </Box>
          ) : null}
          {listo && det.trabajo ? (
            <Box marginTop={1} flexDirection="column">
              {regla(sinTrack ? '? new' : '◐ unstaged', sinTrack ? 'not tracked by git yet' : 'not added yet', sinTrack ? 'subtle' : 'warning')}
              <Code source={det.trabajo} format="diff" path={sel.id} language={lenguaje(sel.id)} />
            </Box>
          ) : null}
          {listo && !det.staged && !det.trabajo ? <Text dimColor>No differences (already committed or empty).</Text> : null}
          <Box marginTop={1} flexDirection="column">
            {sinTrack || mo ? (
              <Button key="add" hotkey="a" onPress={() => void accionGit($, g.raiz, ['add', '--', sel.id]).then(() => cargarDetalle($, g.raiz, sel.id, false))}>
                <Text color="success" bold>add</Text>
              </Button>
            ) : null}
            {st && !mo ? (
              <Button key="unstage" hotkey="s" onPress={() => void accionGit($, g.raiz, ['restore', '--staged', '--', sel.id]).then(() => cargarDetalle($, g.raiz, sel.id, sinTrack))}>
                <Text color="warning" bold>unstage</Text>
              </Button>
            ) : null}
            {!sinTrack ? (
              <Button key="restore" hotkey="r" onPress={() => {
                if (conf !== `restore:${sel.id}`) { void update($, confirmar, () => `restore:${sel.id}`); return }
                void update($, confirmar, () => null)
                void accionGit($, g.raiz, ['restore', '--source=HEAD', '--staged', '--worktree', '--', sel.id]).then(() => update($, seleccion, () => null))
              }}>
                <Text color="error" bold>{conf === `restore:${sel.id}` ? 'restore? (press again to confirm)' : 'restore'}</Text>
              </Button>
            ) : null}
            <Button key="untrack" hotkey="u" onPress={() => {
              if (sinTrack) { void aGitignore($, g.raiz, sel.id).then(() => refrescarGit($)).then(() => update($, seleccion, () => null)); return }
              if (conf !== `untrack:${sel.id}`) { void update($, confirmar, () => `untrack:${sel.id}`); return }
              void update($, confirmar, () => null)
              void accionGit($, g.raiz, ['rm', '--cached', '--quiet', '--', sel.id]).then(() => aGitignore($, g.raiz, sel.id)).then(() => refrescarGit($)).then(() => update($, seleccion, () => null))
            }}>
              <Text color="suggestion" bold>{conf === `untrack:${sel.id}` ? 'untrack? (press again to confirm)' : 'untrack'}</Text>
            </Button>
          </Box>
          <Box marginTop={1}>
            {volverBtn}
          </Box>
        </Box>
      )
    }

    // ── Detalle: archivo de la sesión (fuera de git) ──
    if (sel?.tipo === 'archivo') {
      const a = lista.find(x => x.ruta === sel.id)
      if (a) {
        const { nombre, dir } = partes(relativa(a.ruta, cwd))
        const st = stats(a)
        return (
          <Box flexDirection="column">
            <Box borderStyle="round" borderColor={a.tipo === 'nuevo' ? 'success' : 'warning'} paddingX={1} flexDirection="column">
              <Text wrap="truncate-end">
                {chip(a.tipo === 'nuevo' ? 'NEW' : 'EDITED', a.tipo === 'nuevo' ? 'success' : 'warning')}
                <Text bold>  {nombre}</Text>
              </Text>
              {dir ? <Text dimColor wrap="truncate-end">{dir}</Text> : null}
              <Text>
                <Text color="diffAdded" bold>+{st.mas}</Text>
                <Text dimColor> · </Text>
                <Text color="diffRemoved" bold>−{st.menos}</Text>
                <Text dimColor> · {a.cambios.length} cambio{a.cambios.length === 1 ? '' : 's'}</Text>
              </Text>
            </Box>
            {a.cambios.length === 0 && <Text dimColor>No diff recorded.</Text>}
            {a.cambios.map((c, i) => (
              <Box key={`d${i}`} flexDirection="column" marginTop={1}>
                {regla(`#${i + 1}`, c.nuevo ? 'file created' : 'edit')}
                <Code source={c.patch} format="diff" path={a.ruta} language={lenguaje(a.ruta)} />
              </Box>
            ))}
            <Box marginTop={1} gap={2}>
              {volverBtn}
              <Button key="visto" hotkey="v" onPress={marcar([`a:${a.ruta}`])}>mark seen</Button>
            </Box>
          </Box>
        )
      }
    }

    // ── Detalle: comando ──
    if (sel?.tipo === 'comando') {
      const c = cmds.find(x => x.id === sel.id)
      if (c) {
        const color = c.estado === 'ok' ? 'success' : c.estado === 'error' ? 'error' : 'warning'
        const etiqueta = c.estado === 'ok' ? '✓ OK' : c.estado === 'error' ? '✗ FAILED' : '◌ RUNNING'
        return (
          <Box flexDirection="column">
            <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column">
              <Text wrap="truncate-end">
                {chip(etiqueta, color)}
                <Text bold>  {c.desc ?? 'Command'}</Text>
              </Text>
              {c.t ? <Text dimColor>{hace(ahora - c.t)}</Text> : null}
            </Box>
            <Box marginTop={1} flexDirection="column">
              {regla('$', 'command')}
              <Code source={c.cmd} language="bash" />
            </Box>
            {c.salida ? (
              <Box marginTop={1} flexDirection="column">
                {regla('›', 'output')}
                <Code source={c.salida} language="text" />
              </Box>
            ) : null}
            {c.stderr ? (
              <Box marginTop={1} flexDirection="column">
                {regla('!', 'errors', 'error')}
                <Code source={c.stderr} language="text" />
              </Box>
            ) : null}
            {c.estado !== 'corre' && !c.salida && !c.stderr ? <Text dimColor>(no output)</Text> : null}
            <Box marginTop={1}>{volverBtn}</Box>
          </Box>
        )
      }
    }

    // ── Un commit del historial ──
    if (sel?.tipo === 'hist' && g) {
      const c = hist.find(x => x.hash === sel.id)
      const dc = detCommit?.hash === sel.id ? detCommit : null
      return (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="#b392f0" paddingX={1} flexDirection="column">
            <Text wrap="truncate-end">
              {chip(sel.id.slice(0, 7), '#b392f0')}
              <Text bold>  {c?.asunto ?? ''}</Text>
            </Text>
            {c ? <Text dimColor>{c.autor} · {haceFecha(c.fecha, ahora)} ago{c.archivos !== undefined ? ` · ${c.archivos} files ` : ''}{c.mas !== undefined ? <Text color="success">+{c.mas} </Text> : null}{c.menos !== undefined ? <Text color="error">−{c.menos}</Text> : null}</Text> : null}
            {c && c.refs.length ? <Text wrap="truncate-end">{c.refs.map(r => `[${r}]`).join(' ')}</Text> : null}
          </Box>
          {dc ? (
            <Box flexDirection="column">
              {dc.cuerpo.includes('\n') ? <Box marginTop={1}><Text dimColor>{dc.cuerpo}</Text></Box> : null}
              {dc.archivos.map(f => (
                <Box key={`hf-${f.ruta}`} marginTop={1} flexDirection="column">
                  {regla('◆', f.ruta)}
                  {f.patch ? <Code source={f.patch} format="diff" path={f.ruta} language={lenguaje(f.ruta)} /> : <Text dimColor>  (binary or no changes)</Text>}
                </Box>
              ))}
            </Box>
          ) : <Text dimColor>loading…</Text>}
          <Box marginTop={1} flexDirection="row" gap={1}>
            {volverBtn}
            <Button key="copiar" hotkey="y" onPress={press => $.ui.copy({ text: sel.id, surface: press.surface })}>copy hash</Button>
          </Box>
        </Box>
      )
    }

    // ── Lista ──
    const filaArchivo = (a: Archivo) => {
      const id = `a:${a.ruta}`
      const { nombre, dir } = partes(relativa(a.ruta, cwd))
      const st = stats(a)
      const der = `+${st.mas} −${st.menos}`
      const lugar = Math.max(4, ancho - der.length - 16)
      const izq = recortar(nombre + (dir ? '  ' + dir : ''), lugar)
      const pad = '  '
      const corte = Math.min(nombre.length, izq.length)
      return (
        <Box key={`fa-${a.ruta}`} flexDirection="row" gap={1}>
        <Button key={`a-${a.ruta}`} onPress={elegir({ tipo: 'archivo', id: a.ruta })}>
          <Text color={a.error ? 'error' : a.tipo === 'nuevo' ? 'success' : 'warning'} bold>
            {a.tipo === 'nuevo' ? '● ' : '◐ '}
          </Text>
          <Text bold>{izq.slice(0, corte)}</Text>
          <Text dimColor>{izq.slice(corte)}</Text>
          <Text>{pad}</Text>
          <Text color="diffAdded">+{st.mas}</Text>
          <Text> </Text>
          <Text color="diffRemoved">−{st.menos}</Text>
        </Button>
        {check(id, visto.has(id))}
        </Box>
      )
    }

    const filaGit = (f: GitArchivo | string, tipo: 'staged' | 'mod' | 'nuevo') => {
      const ruta = typeof f === 'string' ? f : f.ruta
      const mas = typeof f === 'string' ? undefined : f.mas
      const menos = typeof f === 'string' ? undefined : f.menos
      const marca = tipo === 'staged' ? '●' : tipo === 'mod' ? '◐' : '+'
      const color = tipo === 'staged' ? 'success' : tipo === 'mod' ? 'warning' : 'suggestion'
      const { nombre, dir } = partes(ruta)
      const lugar = Math.max(4, ancho - 20)
      const izq = recortar(nombre + (dir ? '  ' + dir : ''), lugar)
      const corte = Math.min(nombre.length, izq.length)
      return (
        <Button key={`g-${tipo}-${ruta}`} onPress={abrirGit(ruta, tipo === 'nuevo')}>
          <Text color={color} bold>{marca} </Text>
          <Text bold>{izq.slice(0, corte)}</Text>
          <Text dimColor>{izq.slice(corte)}</Text>
          {mas !== undefined ? <Text>  </Text> : null}
          {mas !== undefined && mas > 0 ? <Text color="diffAdded">+{mas}</Text> : null}
          {mas !== undefined && mas > 0 && (menos ?? 0) > 0 ? <Text> </Text> : null}
          {mas !== undefined && (menos ?? 0) > 0 ? <Text color="diffRemoved">−{menos}</Text> : null}
          {tipo === 'nuevo' ? <Text dimColor>  new</Text> : null}
        </Button>
      )
    }

    const filaComando = (c: Comando) => {
      const cuando = c.t ? hace(ahora - c.t) : ''
      const lugar = Math.max(4, ancho - cuando.length - 11)
      const txt = recortar(c.desc ?? c.cmd, lugar)
      const pad = '  '
      return (
        <Button key={`c-${c.id}`} onPress={elegir({ tipo: 'comando', id: c.id })}>
          <Text color={c.estado === 'ok' ? 'success' : c.estado === 'error' ? 'error' : 'warning'} bold>
            {c.estado === 'ok' ? '✓ ' : c.estado === 'error' ? '✗ ' : '◌ '}
          </Text>
          <Text color={c.estado === 'error' ? 'error' : undefined}>{txt}</Text>
          <Text>{pad}</Text>
          <Text dimColor>{cuando}</Text>
        </Button>
      )
    }

    // Archivos de la sesión: en un repo, solo los que quedan fuera de él
    const sesion = lista.filter(a => !enRepo(a.ruta)).reverse()
    const sesionPend = sesion.filter(a => !visto.has(`a:${a.ruta}`))
    const sesionVistos = sesion.filter(a => visto.has(`a:${a.ruta}`))
    const cs = [...cmds].reverse()
    // Comandos: los últimos 5 a la vista, el resto se va solo al historial
    const csVisibles = cs.slice(0, 5)
    const csHistorial = cs.slice(5)
    const err = cs.filter(c => c.estado === 'error').length

    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="claude" paddingX={1}>
          <Text wrap="truncate-end">
            <Text color="claude" bold>◆ </Text>
            {g ? (
              <Text>
                <Text bold>{partes(g.raiz).nombre}</Text>
                <Text dimColor>  </Text>
                <Text color="claude" bold>⎇ {g.rama}</Text>
                {g.extra ? <Text dimColor> {g.extra}</Text> : null}
                <Text dimColor>  ·  </Text>
              </Text>
            ) : (
              <Text dimColor>no git  ·  </Text>
            )}
            {err > 0 ? <Text color="error">{err} failed</Text> : <Text color="success">all good</Text>}
          </Text>
        </Box>

        {g ? (
          <Box marginTop={1} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button key="b-commit" hotkey="c" onPress={() => {
                if (g.staged.length + g.modificados.length + g.sinTrackear.length === 0) { $.ui.toast('Nothing to commit'); return }
                if (g.conflictos.length > 0) { $.ui.toast('Fix the conflicts first'); return }
                void update($, seleccion, () => ({ tipo: 'commit', id: 'commit' }))
              }}>
                <Text color={g.staged.length + g.modificados.length + g.sinTrackear.length > 0 ? '#4ade80' : 'subtle'} bold>✔ commit</Text>
              </Button>
              <Button key="b-pull" hotkey="p" onPress={() => void correrGit($, g.raiz, 'pull', ['pull', '--no-edit'])}>
                <Text color="#38bdf8" bold>⬇ pull{/↓\s*(\d+)/.exec(g.extra)?.[1] ? ` ${/↓\s*(\d+)/.exec(g.extra)?.[1]}` : ''}</Text>
              </Button>
              <Button key="b-push" hotkey="u" onPress={() => void push($, g)}>
                <Text color="#fbbf24" bold>⬆ push{/↑\s*(\d+)/.exec(g.extra)?.[1] ? ` ${/↑\s*(\d+)/.exec(g.extra)?.[1]}` : ''}</Text>
              </Button>
              <Button key="b-fetch" hotkey="f" onPress={() => void correrGit($, g.raiz, 'fetch', ['fetch', '--prune'])}>
                <Text color="#c4b5fd" bold>⟳ fetch</Text>
              </Button>
            </Box>
            {act ? (
              <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}
                borderColor={act.estado === 'ok' ? 'success' : act.estado === 'corre' ? 'subtle' : act.estado === 'conflicto' ? 'warning' : 'error'}>
                <Text>
                  <Text bold color={act.estado === 'ok' ? 'success' : act.estado === 'corre' ? 'subtle' : act.estado === 'conflicto' ? 'warning' : 'error'}>
                    {act.estado === 'ok' ? '✓ ' : act.estado === 'corre' ? '◌ ' : act.estado === 'conflicto' ? '⚠ ' : '✗ '}
                    {act.accion}
                  </Text>
                  <Text dimColor>{act.estado === 'corre' ? '  running…' : act.estado === 'conflicto' ? '  conflicts!' : ''}</Text>
                </Text>
                {act.texto ? <Text dimColor wrap="wrap">{act.texto}</Text> : null}
                {act.estado !== 'corre' ? (
                  <Button key="b-ok" onPress={() => void update($, accion, () => null)}><Text color="subtle">dismiss</Text></Button>
                ) : null}
              </Box>
            ) : null}
            <Box marginTop={1}>{regla('GIT', `${g.staged.length + g.modificados.length + g.sinTrackear.length} changed`)}</Box>
            {g.conflictos.length > 0 || g.enMerge ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color="error" bold>⚠ CONFLICTS {g.conflictos.length}</Text>
                {g.conflictos.map(r => (
                  <Button key={`cf-${r}`} onPress={abrirGit(r, false)}>
                    <Text color="error">✗ </Text><Text bold>{r}</Text>
                  </Button>
                ))}
                <Text dimColor>fix the files, then + them and commit</Text>
                {g.enMerge ? (
                  <Button key="b-abort" onPress={() => {
                    if (conf !== 'abort') { void update($, confirmar, () => 'abort'); return }
                    void update($, confirmar, () => null)
                    void correrGit($, g.raiz, 'merge --abort', ['merge', '--abort'])
                  }}>
                    <Text color="error" bold>{conf === 'abort' ? 'abort merge? (press again)' : 'abort merge'}</Text>
                  </Button>
                ) : null}
              </Box>
            ) : null}
            {g.staged.length + g.modificados.length + g.sinTrackear.length === 0 && <Text dimColor>  all committed ✓</Text>}
            {g.staged.map(f => filaGit(f, 'staged'))}
            {g.modificados.map(f => filaGit(f, 'mod'))}
            {g.sinTrackear.map(r => filaGit(r, 'nuevo'))}
          </Box>
        ) : null}

        {!g || sesion.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            {regla(g ? 'OUTSIDE REPO' : 'FILES', String(sesionPend.length))}
            {sesionPend.length === 0 && <Text dimColor>  nothing pending</Text>}
            {sesionPend.map(filaArchivo)}
            {sesionVistos.length > 0 ? plegable('archivosVistos', '✓ seen', sesionVistos.length) : null}
            {abierta.has('archivosVistos') ? sesionVistos.map(filaArchivo) : null}
          </Box>
        ) : null}

        <Box marginTop={1} flexDirection="column">
          {regla('COMMANDS', `${cs.length}${err > 0 ? ` · ${err}✗` : ''}`)}
          {cs.length === 0 && <Text dimColor>  nothing yet</Text>}
          {csVisibles.map(filaComando)}
          {csHistorial.length > 0 ? plegable('historial', 'history', csHistorial.length) : null}
          {abierta.has('historial') ? csHistorial.map(filaComando) : null}
        </Box>

        {g && hist.length > 0 ? (() => {
          const filas = armarGrafo(hist)
          const anchoG = Math.min(16, Math.max(2, ...filas.map(f => Math.max(f.nodo.length, f.antes?.length ?? 0, f.despues?.length ?? 0))))
          const dibujar = (celdas: Celda[], k: string) => (
            <Text key={k}>{tramos(celdas, anchoG).map((t, i) => <Text key={`${k}-${i}`} color={t.color} bold={t.bold}>{t.ch}</Text>)}</Text>
          )
          const etiqueta = (r: string, color: string) => {
            if (r.startsWith('HEAD -> ')) return <Text key={r} color="inverseText" backgroundColor={color} bold>{` ${r.slice(8)} `}</Text>
            if (r.startsWith('tag: ')) return <Text key={r} color="warning" bold>{`◆${r.slice(5)}`}</Text>
            if (r === 'HEAD') return <Text key={r} color="inverseText" backgroundColor="warning" bold> HEAD </Text>
            if (r.includes('/')) return <Text key={r} color={color} dimColor>{`☁${r}`}</Text>
            return <Text key={r} color={color} bold>{`[${r}]`}</Text>
          }
          return (
            <Box marginTop={1} flexDirection="column">
              {regla('HISTORY', `${hist.length} commits · ○ not pushed`)}
              {filas.map((f, i) => {
                const c = hist[i]!
                const refsTxt = c.refs.join(' ').length + c.refs.length * 2
                const lugar = Math.max(6, ancho - anchoG - refsTxt - 6)
                // La tarjeta sale abajo, salvo en las últimas filas, donde sale arriba
                const arriba = i > filas.length - 8
                return (
                  <Box key={`h-${c.hash}`} flexDirection="column">
                    {f.antes ? dibujar(f.antes, `ha-${c.hash}`) : null}
                    <Box key={`hr-${c.hash}`} flexDirection="row" hover={{ backgroundColor: '#2a2f3a' }}>
                      {dibujar(f.nodo, `hn-${c.hash}`)}
                      <Button key={`hb-${c.hash}`} onPress={() => {
                        void update($, detalleCommit, () => null)
                        void update($, seleccion, () => ({ tipo: 'hist', id: c.hash }))
                        void cargarCommit($, g.raiz, c.hash)
                      }}>
                        <Text wrap="truncate-end">
                          {c.refs.map(r => <Text key={`e-${r}`}>{etiqueta(r, f.color)} </Text>)}
                          <Text>{recortar(c.asunto, lugar)}</Text>
                          <Text color="subtle"> {haceFecha(c.fecha, ahora)}</Text>
                        </Text>
                      </Button>
                      <Box position="absolute" top={arriba ? -7 : 1} left={anchoG + 2} display="none" hover={{ display: 'flex' }}
                        borderStyle="round" borderColor={f.color} backgroundColor="#1b1f27" paddingX={1} flexDirection="column" width={Math.max(20, Math.min(56, ancho - anchoG - 3))}>
                        <Text wrap="truncate-end"><Text color={f.color} bold>{c.hash.slice(0, 7)}</Text><Text dimColor>  {c.autor} · {haceFecha(c.fecha, ahora)} ago</Text></Text>
                        <Text wrap="wrap">{recortar(c.asunto, 160)}</Text>
                        <Text wrap="truncate-end">
                          {c.archivos !== undefined ? <Text dimColor>{c.archivos} file{c.archivos === 1 ? '' : 's'}  </Text> : <Text dimColor>no file changes  </Text>}
                          {c.mas !== undefined ? <Text color="success">+{c.mas} </Text> : null}
                          {c.menos !== undefined ? <Text color="error">−{c.menos}</Text> : null}
                        </Text>
                        <Text wrap="truncate-end" dimColor>{c.padres.length > 1 ? `merge of ${c.padres.map(p => p.slice(0, 7)).join(' + ')}` : c.sinPush ? 'not pushed yet' : c.refs.length ? c.refs.join(', ') : 'click for diff'}</Text>
                      </Box>
                    </Box>
                    {f.despues ? dibujar(f.despues, `hd-${c.hash}`) : null}
                  </Box>
                )
              })}
            </Box>
          )
        })() : null}

        <Box marginTop={1}>
          <Button key="ocultar" hotkey="h" onPress={() => { void $.store.set('visible', false); void $.ui.close({ id: PANEL }) }}>
            <Text color="subtle">hide panel</Text>
          </Button>
        </Box>
        <Box><Text color="subtle">{g ? 'click a file: diff · add · restore · untrack' : 'click: details · ✓ seen · ↺ undo'}</Text></Box>
      </Box>
    )
  })
}
