export type Ventana = { pct: number; reset?: string }
export type Datos = {
  modelo: string
  ctx?: number
  v5?: Ventana
  v7?: Ventana
  turnos: number
  agentes?: number
  minutos: number
  ahora: number
}

declare module 'claude-code' {
  interface PluginState {
    'estado-uso': { datos: Datos | null }
  }
}
