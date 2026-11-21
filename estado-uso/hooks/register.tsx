import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Datos, Ventana } from '../types'

const datos = atom({ plugin: 'estado-uso', key: 'datos' } as const, null)

const DIAS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function hhmm(d: Date) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function cuando(iso: string | undefined, now: number) {
  if (!iso) return ''
  const min = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60000))
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h${String(min % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// Una mascota por modelo
function mascota(modelo: string) {
  const m = modelo.toLowerCase()
  return m.startsWith('opus') ? '🐙' : m.startsWith('sonnet') ? '🦊' : m.startsWith('haiku') ? '🐝' : m.startsWith('fable') ? '🦑' : '🤖'
}

function nombreModelo(id: string) {
  const m = /(opus|sonnet|haiku|fable)[-\s]?(\d+)[-.](\d+)/i.exec(id)
  if (!m || !m[1]) return id
  const fam = m[1].toLowerCase()
  return `${fam.charAt(0).toUpperCase()}${fam.slice(1)} ${m[2]}.${m[3]}${/\[1m\]/i.test(id) ? ' 1M' : ''}`
}

function duracion(min: number) {
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

function barra(pct: number, ancho: number) {
  const llenos = Math.max(0, Math.min(ancho, Math.round((pct / 100) * ancho)))
  return '━'.repeat(llenos) + '─'.repeat(ancho - llenos)
}

function tono(pct: number) {
  return pct >= 80 ? 'error' : pct >= 50 ? 'warning' : 'success'
}

async function medir($: EngineInterface) {
  const [modelo, uso, turnos, now, lista] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    $.session.turns(),
    $.clock.now(),
    $.agent.list().catch(() => []),
  ])
  const agentes = lista.filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting').length

  // Último valor conocido de cada ventana, guardado entre sesiones: si Claude
  // todavía no informó la ventana, se muestra el último mientras no haya vencido
  const guardadas = ((await $.store.get('ventanas')) ?? {}) as Record<string, Ventana>
  const ventana = (k: string): Ventana | undefined => {
    const r = uso.rateLimits.find(x => x.kind === k)
    if (r) {
      const previa = guardadas[k]?.reset
      const sigueVigente = previa !== undefined && new Date(previa).getTime() > now
      const v = { pct: Math.round(r.percentUsed), reset: r.resetsAt ?? (sigueVigente ? previa : undefined) }
      guardadas[k] = v
      return v
    }
    const g = guardadas[k]
    if (g && (!g.reset || new Date(g.reset).getTime() > now)) return g
    return undefined
  }

  const d: Datos = {
    modelo: nombreModelo(modelo),
    ctx: uso.context.percent,
    v5: ventana('five_hour'),
    v7: ventana('seven_day'),
    turnos,
    agentes,
    minutos: Math.floor((now - uso.startedAt) / 60000),
    ahora: now,
  }
  await $.store.set('ventanas', guardadas)
  await update($, datos, () => d)
}

// Un segmento: piezas de texto con color, y una prioridad (menor = se queda más)
type Pieza = { t: string; color?: string; bold?: boolean; dim?: boolean }
type Seg = { prio: number; piezas: Pieza[] }


// compacto: 0 = completo, 1 = sin "left", 2 = lo más corto posible
function segmentos(d: Datos, compacto: number): Seg[] {
  const peor = Math.max(d.v5?.pct ?? 0, d.v7?.pct ?? 0)
  const humor = peor >= 95 ? '💀' : peor >= 80 ? '🥵' : peor >= 50 ? '😅' : d.v5 && d.v5.pct < 5 ? '😎' : ''
  const s: Seg[] = [{ prio: 0, piezas: [{ t: `${mascota(d.modelo)}${humor} ` }, { t: d.modelo, color: 'claude', bold: true }] }]

  const medidor = (icono: string, etq: string, v: Ventana | undefined, prio: number) => {
    if (!v) return
    // ⏳ 5h 9%  ⏱ 4h37 left   (usado y cuánto falta para el reinicio)
    const p: Pieza[] = [{ t: `${icono} ` }, { t: `${etq} `, dim: true }, { t: `${v.pct}%`, color: tono(v.pct), bold: true }]
    const c = cuando(v.reset, d.ahora)
    if (c) {
      if (compacto === 0) p.push({ t: '  ⏱ ', dim: true }, { t: c, bold: true }, { t: ' left', dim: true })
      else if (compacto === 1) p.push({ t: ' ⏱ ', dim: true }, { t: c, bold: true })
      else p.push({ t: ' ', dim: true }, { t: c, bold: true })
    }
    s.push({ prio, piezas: p })
  }

  medidor('⏳', '5h', d.v5, 1)
  medidor('📅', '7d', d.v7, 2)
  if (d.agentes) s.push({ prio: 3, piezas: [{ t: '🤖 ' }, { t: `${d.agentes}`, bold: true, color: 'suggestion' }, ...(compacto < 2 ? [{ t: d.agentes === 1 ? ' agent' : ' agents', dim: true }] : [])] })
  if (d.ctx !== undefined) s.push({ prio: 4, piezas: [{ t: '🧠 ' }, ...(compacto < 2 ? [{ t: 'ctx ', dim: true }] : []), { t: `${d.ctx}%`, color: tono(d.ctx), bold: true }] })
  s.push({ prio: 5, piezas: [{ t: '🕐 ' }, { t: duracion(d.minutos), dim: true }] })
  return s
}

const SEP_CORTO = ' · '

// Ancho real en la terminal: los emojis ocupan 2 columnas
function anchoTexto(t: string) {
  let n = 0
  for (const ch of t) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 0xfe0f || c === 0x200d) continue
    n += c >= 0x1f000 || (c >= 0x2300 && c <= 0x23ff) || (c >= 0x2600 && c <= 0x27bf) ? 2 : 1
  }
  return n
}

function largo(xs: Seg[], sep: string) {
  return xs.reduce((n, x) => n + x.piezas.reduce((m, p) => m + anchoTexto(p.t), 0), 0) + anchoTexto(sep) * Math.max(0, xs.length - 1)
}

// De más espacioso a más compacto: se usa el primero que entra entero
const NIVELES = [
  { compacto: 0, sep: '  │  ' },
  { compacto: 0, sep: ' │ ' },
  { compacto: 1, sep: ' │ ' },
  { compacto: 2, sep: ' │ ' },
  { compacto: 2, sep: ' · ' },
]

function ajustar(d: Datos, ancho: number) {
  for (const n of NIVELES) {
    const segs = segmentos(d, n.compacto)
    if (largo(segs, n.sep) <= ancho) return { quedan: segs, sep: n.sep }
  }
  // Ni compacto entra: se saca lo menos importante (primero el tiempo, después el contexto)
  let quedan = segmentos(d, 2)
  while (quedan.length > 1 && largo(quedan, SEP_CORTO) > ancho) {
    const peor = quedan.reduce((a, b) => (b.prio > a.prio ? b : a))
    quedan = quedan.filter(x => x !== peor)
  }
  return { quedan, sep: SEP_CORTO }
}

export const register: Register = on => {
  let reloj: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    $.ui.status(undefined)
    reloj?.cancel()
    reloj = $.clock.every(15_000, () => void medir($).catch(() => {}))
    await medir($).catch(() => {})
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    void medir($).catch(() => {})
    return r
  })

  on('session.measure', async ($, e, next) => {
    await medir($).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const linea = await next(e)
    const d = await read($, datos)
    if (d === null || e.surface !== 'terminal') return linea

    const { Box, Text } = $.ui.resolve(e)
    const ancho = (e.viewport?.columns ?? 120) - 4
    const { quedan, sep } = ajustar(d, ancho)


    return (
      <Box flexDirection="column">
        {linea}
        <Box flexDirection="row">
          {quedan.map((seg, i) => (
            <Text key={`s${i}`} wrap="truncate-end">
              {i > 0 ? <Text color="subtle">{sep}</Text> : null}
              {seg.piezas.map((p, j) => (
                <Text key={`p${j}`} color={p.color} bold={p.bold} dimColor={p.dim}>
                  {p.t}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
