export type Cambio = { patch: string; nuevo: boolean }
export type Archivo = { ruta: string; tipo: 'edit' | 'nuevo'; error: boolean; cambios: Cambio[] }
export type Comando = {
  id: string
  cmd: string
  desc?: string
  estado: 'corre' | 'ok' | 'error'
  salida?: string
  stderr?: string
  t?: number
}
export type Seleccion = { tipo: 'archivo' | 'comando' | 'git' | 'commit' | 'hist'; id: string } | null
export type GitArchivo = { ruta: string; x: string; y: string; mas?: number; menos?: number }
export type GitInfo = {
  raiz: string
  rama: string
  extra: string
  staged: GitArchivo[]
  modificados: GitArchivo[]
  sinTrackear: string[]
  conflictos: string[]
  enMerge: boolean
}
export type GitAccion = { accion: string; estado: 'corre' | 'ok' | 'error' | 'conflicto'; texto: string } | null
// Un commit del historial, para el gráfico de ramas
export type Commit = {
  hash: string
  padres: string[]
  autor: string
  fecha: number
  asunto: string
  refs: string[]
  sinPush: boolean
  archivos?: number
  mas?: number
  menos?: number
}
export type CommitDetalle = { hash: string; cuerpo: string; archivos: { ruta: string; patch: string }[] } | null
export type GitDetalle = { ruta: string; staged: string; trabajo: string; nuevo: boolean } | null

declare module 'claude-code' {
  interface PluginState {
    'panel-sesion': {
      archivos: Shaped<Archivo[]>
      comandos: Shaped<Comando[]>
      leidos: number
      seleccion: Seleccion
      vistos: string[]
      abiertos: string[]
      git: GitInfo | null
      detalle: GitDetalle
      confirmar: string | null
      accion: GitAccion
      historial: Commit[]
      detalleCommit: CommitDetalle
    }
  }
}
