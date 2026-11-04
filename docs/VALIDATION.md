# Verificación de la entrega

Comprobado en `desktop` el 4 de noviembre de 2026.

- TypeScript de cliente y servidor: correcto.
- Build de producción: correcto. Vite avisa del tamaño de los chunks del editor oficial;
  los módulos de diagramas se cargan por separado. No hay errores de compilación.
- 12 pruebas de lógica y servidor: correctas.
- 7 flujos E2E con Chromium: correctos. Incluyen dibujo y cambio inmediato, archivos y
  carpetas, imágenes y viewport, importación/exportación, texto y flechas, conflictos,
  recuperación offline y recuperación tras eliminación externa.
- Vista de escritorio y viewport móvil de 390 × 844 inspeccionados. El explorador móvil
  se oculta y deja de ser accesible al cerrarlo; no hay desbordamiento horizontal.
- Fuentes y recursos del editor: el flujo de texto/flechas pasa bloqueando peticiones
  HTTP externas. Los datos de prueba usan vaults temporales independientes.
- `npm audit`: cero vulnerabilidades con el lockfile entregado.
- Formato Prettier: correcto.
- Regresión de empaquetado cubierta: HTML y recursos servidos desde una release bajo
  un directorio oculto como `.local`, manteniendo privados los archivos ocultos.

## Servicio instalado

- Unidad: `excalidraws.service`, habilitada y activa.
- Escucha: `0.0.0.0:3001`.
- Aplicación y API comprobadas en `http://127.0.0.1:3001` y
  `http://100.91.167.48:3001` desde el desktop.
- Vault: `/home/arsu/.local/share/excalidraws/vault`.
- Release: `/home/arsu/.local/share/excalidraws/releases/2026-11-04T00-26-12-987Z`.
- El usuario tiene linger habilitado: el servicio puede arrancar sin sesión interactiva.
- Se creó y dibujó un rectángulo desde Chromium contra el servicio instalado, se esperó
  al guardado y se reinició systemd. El archivo conservó contenido y SHA-256 antes de
  recargar el editor, y el dibujo se recuperó al recargar, sin errores JavaScript.
  El archivo de aceptación y su historial se retiraron después.
- Se forzó un despliegue al puerto 3000, ya ocupado por el servicio anterior. Falló el chequeo
  y el instalador restauró la unidad válida del 3001, que volvió a responder correctamente.
- La instalación anterior `excalidraw.service` permanece en el puerto 3000. No se han
  modificado Tailscale ni los datos de los navegadores.

La comprobación móvil usa un viewport emulado; no es aceptación física en un teléfono.
La conectividad de Tailscale se ha probado desde el desktop, no desde otro dispositivo.
El workflow de GitHub está preparado; aún no se ha ejecutado remotamente porque esta
entrega se ha realizado como commit local, sin publicación.
