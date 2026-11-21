# claude-mods

Mods personales de Claude Code.

- **estado-uso** — línea bajo el prompt: modelo, contexto, límites 5h/7d, costo de hoy y de la semana.
- **panel-sesion** — panel lateral: git status/diff en repos, archivos y comandos de la sesión con marcar como visto.

## Instalación

Clonar en `~/.claude/mods` y agregar en `~/.claude/settings.json`:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/estado-uso:~/.claude/mods/panel-sesion"
}
```

Los tipos en `*/.claude-plugin/types/` los genera Claude Code y no se versionan.
