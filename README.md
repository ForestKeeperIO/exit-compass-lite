# Exit Compass Lite

Exit Compass es un compañero de trabajo de Ambiguous para el momento en que una persona responsable de cuentas se va. Lee evidencia sintética de Maya Chen y Acme Corp en Mail, CRM, Tasks, Docs y Calendar; usa una llamada estructurada de OpenAI para encontrar riesgos; crea un Brief de traspaso y un borrador de actualización al cliente; y espera aprobación explícita antes de crear tareas.

La idea central: cuando alguien se va, su trabajo no debería irse con esa persona.

## Configuración

Requisitos: Node 18 o superior, `fetch` nativo y un espacio de trabajo de Ambiguous.

```bash
npm install
cp .env.example .env
```

Configura en `.env`:

```bash
AMBIGUOUS_API_KEY=tu_clave_de_agente_de_ambiguous
OPENAI_API_KEY=tu_clave_de_openai
AMBIGUOUS_INBOX_ADDRESS=exit-compass@example.com
```

La dirección `example.com` es sintética y no entrega correo real.

## Demo de producción en Ambiguous

```bash
npm run run
```

`run` reanuda automáticamente la semilla si `run.json` está vacío o incompleto. El flujo crea y conecta registros reales en Ambiguous:

- 3 mensajes sintéticos de Mail sobre seguridad, precios y renovación;
- 2 tareas abiertas de Maya;
- 1 contacto de CRM de Acme;
- 1 evento real en Calendar mediante `GET /api/calendars` y `POST /api/calendars/{calendarId}/events`;
- 1 nota interna en Docs con diez exposiciones del traspaso;
- 1 Brief de traspaso en Docs;
- 1 borrador de actualización al cliente en Docs.

Abre [app.ambiguous.ai](https://app.ambiguous.ai) y muestra las superficies Mail, CRM, Calendar, Docs y Tasks. El programa imprime URLs directas para cada registro.

Después de explicar el límite de aprobación:

```bash
npm run approve
```

La aprobación solo crea estas tres acciones prioritarias, cada una enlazada al Brief:

1. Completar el cuestionario de seguridad de Acme.
2. Enviar el paquete de precios de Acme.
3. Preparar el traspaso de la reunión de renovación de Acme.

La frase exacta es `APPROVE_ACME_HANDOFF`. No se envía ningún mensaje externo automáticamente.

## Diez exposiciones del traspaso

El Brief y la nota interna muestran problemas que pueden desaparecer con Maya si nadie los asigna:

1. Cuestionario de seguridad con fecha límite el viernes.
2. Paquete de precios sin sucesor.
3. Nueva persona responsable ausente en la reunión de renovación.
4. Dependencia de configuración SSO.
5. Responsable de DPA o Legal no definido.
6. Enlace de evidencia SOC 2 potencialmente vencido.
7. Aceptación de implementación no registrada.
8. Escalación de soporte sin sucesor.
9. Pronóstico de renovación desactualizado.
10. Contacto de Compras u orden de compra desconocidos.

La salida de OpenAI sigue siendo estrictamente validada y prioriza los tres riesgos inmediatos; las diez exposiciones hacen visible el impacto más amplio del traspaso.

## Arquitectura

```text
npm run run
  ├─ Ambiguous REST: Mail / CRM / Tasks / Calendar / Docs
  ├─ run.json: IDs reales devueltos por Ambiguous
  ├─ OpenAI Responses API: una llamada JSON estructurada estricta
  ├─ Docs: Brief de traspaso + borrador sin enviar
  └─ npm run approve: exactamente 3 tareas enlazadas al Brief
```

## API utilizada

- `POST /api/mail/send` y `GET /api/mail/:id`
- `POST /api/crm/contacts` y `GET /api/crm/contacts`
- `POST /api/tasks` y `GET /api/tasks/:id`
- `GET /api/calendars` y `GET/POST /api/calendars/{calendarId}/events`
- `POST /api/documents` y `GET /api/documents/:id`

El espacio de trabajo expone Calendar con rutas bajo `/api/calendars/{calendarId}/events`; las rutas antiguas sin alcance `/api/calendar/*` devuelven 404 en este entorno. `npm run diagnose-calendar` hace una comprobación de solo lectura.

## Demo local visual

Si las credenciales de producción no están disponibles:

```bash
npm run demo:ui
```

Abre [http://localhost:4173/demo.html](http://localhost:4173/demo.html). La pantalla muestra los tres riesgos, las diez exposiciones, los artefactos y el límite de aprobación usando datos sintéticos locales. La ejecución local escribe en `run.local.json`, que está ignorado por Git.

## Ponytail

El proyecto usa [Ponytail de Dietrich Gebert](https://github.com/DietrichGebert/ponytail) como base de desarrollo. Mantiene el enfoque de mínima complejidad: `fetch` nativo, I/O nativo, una entrada TypeScript, una llamada de modelo, validación manual en el límite de confianza y ninguna dependencia HTTP adicional.

## Seguridad

- `.env`, credenciales de Ambiguous, `node_modules`, `dist` y `run.local.json` están ignorados.
- Todas las identidades del seed son sintéticas.
- `run` nunca envía correo al cliente.
- La creación de tareas está bloqueada hasta la frase de aprobación exacta.
