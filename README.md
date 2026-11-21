# claude-mods

Dos mods para [Claude Code](https://claude.com/claude-code): uno para ver el consumo y otro para ver lo que cambió en la sesión.

| Mod | Qué hace |
|---|---|
| [`estado-uso`](./estado-uso) | Línea de estado bajo el prompt: modelo, límites 5h / 7d, contexto, agentes y duración |
| [`panel-sesion`](./panel-sesion) | Panel lateral con los archivos y comandos de la sesión, más git status / diff / commit / push |

---

## estado-uso

Agrega una línea debajo del prompt que se actualiza cada 15 segundos:

```
🐙 Opus 5.5  │  ⏳ 5h 23%  ⏱ 3h12 left  │  📅 7d 41%  ⏱ 2d 5h left  │  🤖 2 agents  │  🧠 ctx 37%  │  🕐 1h04
```

- **Modelo**: con un ícono por familia (🐙 Opus, 🦊 Sonnet, 🐝 Haiku, 🦑 Fable).
- **Límite de 5 horas y de 7 días**: el porcentaje usado y cuánto falta para que se reinicie.
- **Agentes**: cuántos subagentes están corriendo.
- **Contexto**: cuánto de la ventana de contexto está ocupado.
- **Duración**: cuánto tiempo lleva la sesión.

Los porcentajes cambian de color según cuánto usaste: verde por debajo del 50 %, amarillo hasta el 80 % y rojo de ahí para arriba.

**Se adapta al ancho de la terminal.** Primero achica los separadores, después saca la palabra "left", y si todavía no entra, saca lo menos importante (primero la duración, después el contexto).

**Recuerda los límites entre sesiones.** Al arrancar una sesión, Claude todavía no informó los límites. Mientras tanto se muestra el último valor guardado, siempre que esa ventana no se haya reiniciado.

---

## panel-sesion

Abre un panel al costado del chat con todo lo que pasó en la sesión.

### Sesión
- **Archivos** que Claude editó o creó, con el diff de cada cambio.
- **Comandos** que corrió, con su estado (corriendo / ok / error), salida y stderr.
- **Marcar como visto** (`v`), para saber qué ya revisaste.

### Git
Si el directorio está dentro de un repo, el panel muestra:
- La rama, y cuántos commits tenés adelante o atrás del remoto.
- Los archivos staged, modificados, sin trackear y con conflictos.
- El diff de cada archivo, con botones para `add` (`a`), `unstage` (`s`), `restore` (`r`) y dejar de trackearlo / mandarlo a `.gitignore` (`u`).
- Las acciones **commit** (`c`), **pull** (`p`), **push** (`u`) y **fetch** (`f`). Si la rama no tiene remoto, el push la publica en `origin`.
- **Mensaje de commit automático**: Haiku lee el diff staged y propone una línea con el mismo estilo de tus últimos commits.
- Si hay un merge en curso, te deja abortarlo.

### Comandos
- `/panel` muestra u oculta el panel.
- `h` lo oculta y `b` vuelve atrás.
- Si lo cerrás, queda oculto también en las próximas sesiones hasta que lo vuelvas a abrir con `/panel`.

---

## Instalación

```bash
git clone https://github.com/santiagofr1/claude-mods.git ~/.claude/mods
```

Después agregá esto en `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/estado-uso:~/.claude/mods/panel-sesion"
  }
}
```

Reiniciá Claude Code. Si querés usar uno solo, dejá únicamente esa ruta en la variable.

## Estructura

```
<mod>/
├── .claude-plugin/plugin.json   # nombre, versión, descripción
├── hooks/hooks.json             # módulos a cargar
├── hooks/register.tsx           # el código del mod
├── types/index.d.ts             # tipos del estado del mod
└── tsconfig.json
```

Claude Code genera los tipos de `.claude-plugin/types/` y no se suben al repo.
