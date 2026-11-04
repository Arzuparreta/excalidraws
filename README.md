# Excalidraws

Excalidraw oficial con un explorador lateral y archivos reales en tu servidor.
Cada lienzo es un `.excalidraw` independiente: puedes editarlo desde el navegador,
abrirlo con Excalidraw o incluir la carpeta en tus copias de seguridad.

Se integra mediante `@excalidraw/excalidraw` y su API pública. No es un fork,
un userscript ni una extensión instalable sobre excalidraw.com. El editor se mantiene
como dependencia; este repositorio añade la gestión de documentos y el servicio de archivos.

## Uso

- Crea lienzos y carpetas desde el lateral. Busca por nombre o ruta.
- El menú `…` permite renombrar, mover y enviar archivos o carpetas a la papelera.
- El guardado es automático tras 650 ms de pausa. Cambiar de lienzo espera al guardado.
- Los dibujos incluyen imágenes y conservan desplazamiento y zoom.
- Importa uno o varios `.excalidraw` sin reemplazar otros archivos. Descárgalos desde la cabecera.
- La papelera permite restaurar; el historial conserva las últimas 20 versiones anteriores
  **por ruta**. Recuperar una versión crea un lienzo nuevo.
- Si el archivo cambia en otro dispositivo o en el disco, se recarga cuando está limpio.
  Si hay cambios locales, se muestra un conflicto: puedes guardar una copia, descargarla
  o cargar la versión del servidor. No se sobrescribe automáticamente la otra versión.

Es un workspace personal, sin colaboración simultánea ni fusión de dibujos. Los dos
clientes que editan una misma revisión no pueden guardar ambos sobre ella: el segundo
recibe un conflicto. Las escrituras externas no cooperan con nuestro bloqueo; se comprueba
la revisión de nuevo justo antes del rename, pero una herramienta externa que escriba
exactamente en ese intervalo aún podría competir. Evita editar el mismo archivo a la vez.

## Desarrollo

Requiere Node **22.12 o posterior**, npm y Linux para el instalador systemd.

```sh
npm ci
npm run dev
```

Abre `http://localhost:5173`. Vite conecta con la API en `127.0.0.1:3001`.
Por defecto los archivos se guardan en `./data/` (ignorado por Git).

```sh
npm run build
npm start
```

La versión compilada sirve frontend y API en `http://127.0.0.1:3001`.
Incluye los recursos y fuentes de Excalidraw; no necesita un CDN para el editor.

| Variable        | Valor predeterminado | Uso                                         |
| --------------- | -------------------- | ------------------------------------------- |
| `VAULT_DIR`     | `./data`             | Carpeta de archivos                         |
| `HOST`          | `127.0.0.1`          | Dirección de escucha                        |
| `PORT`          | `3001`               | Puerto HTTP                                 |
| `ALLOWED_HOSTS` | vacío                | Nombres DNS adicionales separados por comas |

Se aceptan `localhost`, el hostname del equipo y direcciones IP. Para un nombre DNS de
Tailscale o un proxy, inclúyelo en `ALLOWED_HOSTS` y conserva Host y Origin al hacer proxy.
Si el proxy termina HTTPS, configura `PUBLIC_ORIGIN=https://draw.example.com` (instalador: `--origin`).
La API rechaza orígenes ajenos, rutas ocultas, escapes del vault y enlaces simbólicos.
No hay cuentas ni autenticación: usa loopback o una red privada de confianza. Si lo expones
a Internet, coloca autenticación y HTTPS delante. Límite por documento: 40 MB.

## Servicio systemd de usuario

El instalador crea una release independiente del checkout, instala dependencias de
producción y activa `excalidraws.service`. Las actualizaciones conservan la unidad anterior
y revierten si falla el chequeo HTTP. El vault permanece fuera de las releases.

```sh
npm run build
node scripts/install-service.mjs --dry-run
node scripts/install-service.mjs
# Para acceder desde tu LAN o Tailscale:
node scripts/install-service.mjs --host 0.0.0.0 --port 3001
```

Por defecto: `~/.local/share/excalidraws/vault`. El instalador respeta `XDG_DATA_HOME`
y `XDG_CONFIG_HOME`. No modifica el antiguo `excalidraw.service` del contenedor ni Tailscale.

```sh
systemctl --user status excalidraws
systemctl --user restart excalidraws
journalctl --user -u excalidraws -f
```

Arranca con la sesión de usuario. Para ejecutarlo también sin sesión, activa el linger
del usuario si tu sistema aún no lo tiene (`loginctl enable-linger "$USER"`).

Para volver a una release anterior, copia su backup de unidad sobre
`~/.config/systemd/user/excalidraws.service`, ejecuta `daemon-reload` y reinicia el servicio.
Para desinstalar: `systemctl --user disable --now excalidraws`, elimina esa unidad y ejecuta
`daemon-reload`. Elimina las releases si quieres; conserva el vault para conservar tus dibujos.

### Migración y copias de seguridad

El frontend estándar guarda en el navegador, no en el servidor. Exporta allí tus dibujos
como `.excalidraw` e impórtalos aquí. Los datos del navegador de otro puerto no se comparten.
Este módulo no borra el almacenamiento del frontend anterior.

Haz copia de **todo el vault**, incluida `.workspace/` (historial y papelera). Detén el servicio
para una copia consistente. Al restaurar una copia con el servicio detenido, elimina solo
`.workspace/server.lock` si procede: un PID de otro sistema puede coincidir con uno activo.
No uses una carpeta editable por usuarios no confiables ni varios servidores sobre el mismo
vault. El bloqueo evita dos instancias locales; no coordina hosts diferentes por NFS.
El historial basado en ruta comienza de nuevo al mover o renombrar un documento; las versiones
anteriores permanecen en `.workspace/history` bajo la ruta anterior.

Los borradores locales se guardan en IndexedDB en cada cambio. Su disponibilidad depende del
almacenamiento del navegador; el estado «Guardado» indica confirmación del servidor. Mantén
la página abierta hasta verlo antes de cerrar: el navegador avisa si quedan cambios.

## Verificación y actualizaciones

```sh
npm test
npm run build
npx playwright install chromium  # solo si no está instalado
npm run test:e2e
```

Las pruebas del servidor y la sesión cubren imágenes, escrituras concurrentes, cambios
externos, rutas, enlaces simbólicos, papelera, historial, borradores y guardado durante una
petición en curso. Playwright usa el build real con un vault temporal y prueba el editor,
cambios rápidos, recarga, conflictos, recuperación offline, importación/exportación y móvil.
No utiliza el vault personal ni el servicio instalado.

Las versiones están fijadas en `package.json` y `package-lock.json`. Los overrides resuelven
avisos conocidos en dependencias transitivas de Excalidraw (nanoid, lodash-es y KaTeX).
Al actualizar, revisa el changelog del editor y los overrides, ejecuta `npm run check` y
`npm audit`, y comprueba visualmente dibujo, texto, flechas, imágenes, viewport e importación.
El adaptador `src/editor/ExcalidrawAdapter.tsx` es la frontera con Excalidraw 0.18.1.

Arquitectura y decisiones: [docs/PLAN.md](docs/PLAN.md).
