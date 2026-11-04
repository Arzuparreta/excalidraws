# Excalidraws: plan y límites

## Objetivo

Convertir el editor oficial de Excalidraw en un espacio personal de archivos: explorador
permanente a la izquierda, carpetas, varios lienzos, autoguardado en el desktop y acceso
desde otros dispositivos. El repositorio comienza vacío; no se mantiene un fork del editor.

## Arquitectura

- React + `@excalidraw/excalidraw`, con versiones exactas y lockfile. Solo el adaptador
  conoce la API del editor (`initialData`, `onChange`, serialización pública).
- Módulo `src/workspace`: cliente del contrato HTTP, ciclo de guardado y explorador.
  La página de integración únicamente monta ese módulo.
- Node + Express: sirve la aplicación compilada y una API del mismo origen.
- Una carpeta configurable es la fuente de verdad. Los documentos son archivos JSON
  `.excalidraw` normales, con imágenes embebidas y posición del lienzo. No hay base de datos.
- Revisiones SHA-256 y escrituras temporales + fsync + rename. Una cola serializa las
  mutaciones del servicio. El cliente envía siempre la revisión que abrió.
- Papelera e historial fuera del árbol visible. Los nombres y rutas se validan y no se
  siguen enlaces simbólicos. Las peticiones de escritura de otros orígenes se rechazan.

## Integridad y experiencia

- Los cambios se guardan tras una pausa corta; el borrador se conserva también en IndexedDB.
- Cambiar de documento espera al guardado. Un error o conflicto mantiene el lienzo abierto.
- Una modificación externa se recarga si el editor está limpio; si hay cambios locales,
  se conserva el borrador y se ofrece recargar o guardar una copia.
- La recuperación tras recargar la página compara la revisión original del borrador.
- Las carpetas y los archivos se pueden crear, renombrar y mover; eliminar envía a papelera.
- Importar/exportar usa el formato nativo. Sin colaboración CRDT: dos dispositivos pueden
  trabajar y detectar conflictos, pero no fusionan cambios simultáneos.

## Entrega y verificación

1. Contrato y pruebas de archivos, concurrencia, rutas, papelera e historial.
2. Editor, explorador adaptable, búsqueda, autoguardado y recuperación.
3. Pruebas reales del editor: dibujar, cambiar, recargar, imágenes, conflictos, móvil.
4. Build autocontenido (incluidos fonts), instalador systemd con copia de la unidad anterior,
   comprobación HTTP y documentación de actualización, copias de seguridad y reversión.

## Actualizaciones

No se accede al DOM interno ni se importa código privado de Excalidraw. Las actualizaciones
son explícitas: revisar changelog, actualizar versión fijada y ejecutar las comprobaciones
de compatibilidad. No se promete compatibilidad ilimitada con futuras versiones 0.x.
