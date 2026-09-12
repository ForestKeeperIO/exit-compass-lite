import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE_URL = "https://app.ambiguous.ai";
const RUN_PATH = resolve("run.json");
const LOCAL_RUN_PATH = resolve("run.local.json");
const MAYA_EMAIL = "maya.chen@example.com";
const ACME_CONTACT_EMAIL = "jordan.lee@acme.example";
const APPROVAL_PHRASE = "APPROVE_ACME_HANDOFF";

const HANDOFF_WATCHOUTS = [
  ["Cuestionario de seguridad vence el viernes", "Un entregable prometido al cliente puede incumplirse durante la salida de Maya.", "Asignar a la persona responsable y completar la revisión de la dependencia SSO."],
  ["El paquete de precios no tiene sucesor", "La promesa de precios de Maya existe en Mail, pero nadie más es responsable de entregarla.", "Asignar responsable y confirmar el envío del viernes."],
  ["Falta la nueva persona responsable en la renovación", "Acme puede llegar a la reunión de renovación sin conocer a quien tomará la cuenta.", "Nombrar al sucesor y agregarlo al evento."],
  ["Dependencia de configuración SSO", "La revisión de seguridad depende de una lista técnica que no aparece en la tarea del cliente.", "Vincular al responsable técnico y la evidencia de finalización."],
  ["Responsable de revisión DPA / Legal no definido", "Una pregunta tardía de privacidad o compras puede frenar la renovación después del trabajo comercial.", "Confirmar la persona revisora de Legal y la ruta de escalamiento."],
  ["El enlace de evidencia SOC 2 puede estar vencido", "El paquete de seguridad puede ser rechazado si no se valida su enlace o fecha de vigencia.", "Validar el paquete de evidencia actual antes de enviarlo."],
  ["La aceptación de implementación no está registrada", "El riesgo de renovación aumenta si el último hito no tiene responsable de aceptación escrita.", "Registrar el estado de aceptación y al líder de entrega."],
  ["La escalación de soporte no tiene sucesor", "Un problema abierto del cliente puede convertirse en una sorpresa ejecutiva después de la salida de Maya.", "Transferir la escalación con severidad, SLA y próxima actualización."],
  ["El pronóstico de renovación no está actualizado", "El CRM puede verse saludable aunque la reunión y los compromisos ya estén en riesgo.", "Actualizar pronóstico, riesgo y plan de cierre después del traspaso."],
  ["Contacto de Compras / orden de compra desconocido", "La renovación puede retrasarse aunque se cierre comercialmente si no se conoce el proceso de compras de Acme.", "Confirmar contacto de Compras, fecha de orden y requisitos de facturación."],
] as const;

type JsonObject = Record<string, unknown>;
type MaybeEnvelope = JsonObject | JsonObject[];

type PlanRisk = {
  risk_type: "security_due" | "pricing_unassigned" | "renewal_missing_incoming_am";
  why_it_matters: string;
  deadline: string | null;
  recommended_owner: string;
  next_action: string;
  evidence_id: string;
};

type HandoffPlan = {
  summary: string;
  risks: [PlanRisk, PlanRisk, PlanRisk];
  draft_client_update: string;
};

type RunState = {
  version: 1;
  scenario: { departingManager: string; client: string };
  seed: JsonObject | null;
  plan: HandoffPlan | null;
  artifacts: { brief: JsonObject; clientUpdateDraft: JsonObject } | null;
  approval: { status: "in_progress" | "approved"; taskIds: string[] } | null;
};

function loadDotEnv(): void {
  try {
    const text = readFileSync(resolve(".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // Environment variables may be supplied by the shell instead.
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and add it.`);
  return value;
}

function apiKey(): string {
  return requiredEnv("AMBIGUOUS_API_KEY");
}

async function ambiguous<T = JsonObject>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey()}`);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!response.ok) {
    const allow = response.headers.get("allow");
    const hint = allow ? ` (Allow: ${allow})` : "";
    throw new Error(`Ambiguous ${init.method ?? "GET"} ${path} -> ${response.status}${hint}: ${String(text).slice(0, 500)}`);
  }
  return body as T;
}

function post<T = JsonObject>(path: string, body: JsonObject): Promise<T> {
  return ambiguous<T>(path, { method: "POST", body: JSON.stringify(body) });
}

function get<T = JsonObject>(path: string): Promise<T> {
  return ambiguous<T>(path);
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function firstId(value: unknown): string {
  const object = asObject(value);
  const direct = object.id;
  if (typeof direct === "string" && direct) return direct;
  for (const key of ["document", "doc", "message", "mail", "task", "event", "contact", "deal", "result"]) {
    const nested = asObject(object[key]).id;
    if (typeof nested === "string" && nested) return nested;
  }
    throw new Error(`La respuesta de Ambiguous no contiene un ID de registro: ${JSON.stringify(value).slice(0, 500)}`);
}

function listItems(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(asObject);
  const object = asObject(value);
  for (const key of ["items", "results", "data", "messages", "tasks", "events", "contacts"]) {
    if (Array.isArray(object[key])) return object[key].map(asObject);
  }
  return [];
}

function recordUrl(kind: string, id: string): string {
  const paths: Record<string, string> = {
    mail: "mail",
    task: "tasks",
    document: "docs",
    contact: "crm/contacts",
    event: "calendar/events",
  };
  return `${BASE_URL}/${paths[kind] ?? kind}/${id}`;
}

function readState(): RunState {
  const path = localDemoEnabled() ? LOCAL_RUN_PATH : RUN_PATH;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunState;
  } catch {
    if (path !== RUN_PATH) return JSON.parse(readFileSync(RUN_PATH, "utf8")) as RunState;
    throw new Error("run.json no existe o no es válido.");
  }
}

function saveState(state: RunState): void {
  const path = localDemoEnabled() ? LOCAL_RUN_PATH : RUN_PATH;
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextWeekday(targetDay: number, from = new Date()): Date {
  const date = new Date(from);
  const delta = (targetDay - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + delta);
  date.setHours(10, 0, 0, 0);
  return date;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function documentContent(blocks: JsonObject[]): string {
  return blocks.map((block) => {
    const text = String(block.text ?? "");
    if (block.type === "heading") return "#".repeat(Math.max(1, Number(block.level ?? 1))) + " " + text;
    return text;
  }).join("\n\n");
}

async function seed(): Promise<void> {
  if (localDemoEnabled()) return localSeed();
  const state = readState();
  if (state.seed && isCompleteSeed(state.seed)) {
    console.log("La semilla ya existe en run.json; se conserva para evitar registros duplicados.");
    printSeed(state.seed);
    return;
  }

  const due = nextWeekday(5);
  const meetingStart = addDays(due, 3);
  meetingStart.setHours(14, 0, 0, 0);
  const meetingEnd = addDays(meetingStart, 0);
  meetingEnd.setMinutes(60);

  const seedData = state.seed ?? { dueDate: isoDate(due), renewalMeetingStart: meetingStart.toISOString() };
  const seededDueDate = String(seedData.dueDate);
  const seededMeetingStart = String(seedData.renewalMeetingStart);
  const seededMeetingEnd = new Date(seededMeetingStart);
  seededMeetingEnd.setMinutes(seededMeetingEnd.getMinutes() + 60);
  state.seed = seedData;
  saveState(state);

  if (!asObject(seedData.contact).id) {
    let contactId: string;
    try {
      const contactResponse = await post("/api/crm/contacts", {
        type: "person",
        name: "Jordan Lee — Acme Corp",
        email: ACME_CONTACT_EMAIL,
      });
      contactId = firstId(contactResponse);
    } catch (error) {
      const match = (error instanceof Error ? error.message : String(error)).match(/contact_id["']?\s*:\s*["']([^"']+)["']/);
      if (!match) throw error;
      contactId = match[1];
      console.log(`Se reutiliza el contacto sintético existente de Acme: ${contactId}.`);
    }
    seedData.contact = { id: contactId, url: recordUrl("contact", contactId) };
    saveState(state);
  }

  const mailBodies = [
    {
      subject: "Renovación de Acme: cuestionario de seguridad y precios vencen el viernes",
      body_markdown: `De: Acme Corp <${ACME_CONTACT_EMAIL}>\n\nHola Maya, por favor envía el cuestionario de seguridad completo y el paquete de precios de renovación antes del ${seededDueDate} (viernes).`,
    },
    {
      subject: "Re: Renovación de Acme: cuestionario de seguridad y precios vencen el viernes",
      body_markdown: `De: Maya Chen <${MAYA_EMAIL}>\n\nEnviaremos el cuestionario de seguridad completo y el paquete de precios el viernes ${seededDueDate}.`,
    },
    {
      subject: "Reunión de renovación de Acme confirmada para la próxima semana",
      body_markdown: `De: Acme Corp <${ACME_CONTACT_EMAIL}>\n\nLa reunión de renovación está confirmada para la próxima semana. Por favor incluye a la nueva persona responsable de la cuenta.`,
    },
  ];
  const inbox = process.env.AMBIGUOUS_INBOX_ADDRESS ?? "exit-compass@example.com";
  const mailRecords = Array.isArray(seedData.mail) ? seedData.mail as JsonObject[] : [];
  seedData.mail = mailRecords;
  for (let index = mailRecords.length; index < mailBodies.length; index += 1) {
    const response = await post("/api/mail/send", { to: [inbox], ...mailBodies[index] });
    const id = firstId(response);
    mailRecords.push({ id, url: recordUrl("mail", id) });
    saveState(state);
  }

  const taskBodies = [
    {
      title: "Maya: Dar seguimiento a precios de Acme",
      description: `Tarea abierta de Maya Chen para ${seededDueDate}. Cliente: Acme Corp.`,
      priority: "high",
    },
    {
      title: "Maya: Coordinar revisión de seguridad de Acme",
      description: `Tarea abierta de Maya Chen para ${seededDueDate}. Cliente: Acme Corp.`,
      priority: "high",
    },
  ];
  const taskRecords = Array.isArray(seedData.tasks) ? seedData.tasks as JsonObject[] : [];
  seedData.tasks = taskRecords;
  for (let index = taskRecords.length; index < taskBodies.length; index += 1) {
    const response = await post("/api/tasks", taskBodies[index]);
    const id = firstId(response);
    taskRecords.push({ id, url: recordUrl("task", id) });
    saveState(state);
  }

  if (!asObject(seedData.calendarEvent).id) {
    const calendars = await get("/api/calendars");
    const calendar = listItems(calendars)[0] ?? {};
    const calendarId = typeof calendar.id === "string" ? calendar.id : "";
    if (!calendarId) throw new Error(`Ambiguous GET /api/calendars returned no calendar id: ${JSON.stringify(calendars).slice(0, 500)}`);
    const eventResponse = await post(`/api/calendars/${encodeURIComponent(calendarId)}/events`, {
      title: "Reunión de renovación de Acme Corp",
      start_at: seededMeetingStart,
      end_at: seededMeetingEnd.toISOString(),
      attendees: [MAYA_EMAIL, ACME_CONTACT_EMAIL],
    });
    const eventId = firstId(eventResponse);
    seedData.calendarEvent = { id: eventId, calendarId, url: recordUrl("event", eventId) };
    saveState(state);
  }

  if (!asObject(seedData.deliveryNote).id) {
    const deliveryNoteResponse = await post("/api/documents", {
      type: "doc",
      title: "Nota de entrega de Acme — dependencia técnica",
      content: documentContent([
        { type: "heading", level: 1, text: "Nota de entrega de Acme" },
        { type: "paragraph", text: "Nota interna sintética para el demo de Exit Compass." },
        { type: "paragraph", text: "La revisión de seguridad depende de la lista de configuración SSO del equipo de plataforma antes de marcar el cuestionario como completo." },
        { type: "paragraph", text: "Responsable actual de la relación: Maya Chen. No hay sucesor registrado." },
        { type: "heading", level: 2, text: "Mapa de exposiciones del traspaso" },
        ...HANDOFF_WATCHOUTS.map(([issue, impact, action], index) => ({ type: "paragraph", text: `${index + 1}. ${issue}: ${impact} Próxima acción: ${action}` })),
      ]),
    });
    const noteId = firstId(deliveryNoteResponse);
    seedData.deliveryNote = { id: noteId, url: recordUrl("document", noteId) };
    saveState(state);
  }

  if (!isCompleteSeed(seedData)) throw new Error("El checkpoint de la semilla está incompleto. Ejecuta `npm run seed` otra vez para continuar.");
  saveState(state);
  printSeed(seedData);
  console.log("\nSemilla completa. Ejecuta `npm run run` para analizar este contexto acotado.");
}

function printSeed(seed: JsonObject): void {
  console.log("Registros sintéticos de Maya Chen / Acme Corp creados:");
  const labels: Record<string, string> = { contact: "contacto", mail: "correo", tasks: "tareas", calendarEvent: "evento de calendario", deliveryNote: "nota de entrega" };
  for (const [key, value] of Object.entries(seed)) {
    if (key === "mail" || key === "tasks") {
      for (const item of value as JsonObject[]) console.log(`  ${labels[key]}: ${String(item.url)}`);
    } else if (asObject(value).url) {
      console.log(`  ${labels[key] ?? key}: ${String(asObject(value).url)}`);
    }
  }
}

function riskLabel(riskType: string): string {
  return ({
    security_due: "cuestionario de seguridad con fecha límite",
    pricing_unassigned: "paquete de precios sin responsable",
    renewal_missing_incoming_am: "nueva persona responsable ausente en la renovación",
  } as Record<string, string>)[riskType] ?? riskType;
}

function isCompleteSeed(seed: JsonObject): boolean {
  return Boolean(
    typeof seed.dueDate === "string" &&
    asObject(seed.contact).id &&
    Array.isArray(seed.mail) && (seed.mail as JsonObject[]).length === 3 &&
    Array.isArray(seed.tasks) && (seed.tasks as JsonObject[]).length === 2 &&
    asObject(seed.calendarEvent).id &&
    asObject(seed.deliveryNote).id,
  );
}

function localDemoEnabled(): boolean {
  return process.env.EXIT_COMPASS_LOCAL_DEMO === "1";
}

function localUrl(kind: string, id: string): string {
  return `local://${kind}/${id}`;
}

function localSeed(): void {
  const state = readState();
  const due = nextWeekday(5);
  const meetingStart = addDays(due, 3);
  meetingStart.setHours(14, 0, 0, 0);
  const seed: JsonObject = {
    dueDate: isoDate(due),
    renewalMeetingStart: meetingStart.toISOString(),
    contact: { id: "local_contact_acme", url: localUrl("crm/contacts", "local_contact_acme") },
    mail: ["local_mail_security", "local_mail_maya_commitment", "local_mail_renewal"].map((id) => ({ id, url: localUrl("mail", id) })),
    tasks: ["local_task_pricing", "local_task_security"].map((id) => ({ id, url: localUrl("tasks", id) })),
    calendarEvent: { id: "local_event_renewal", calendarId: "local_calendar", url: localUrl("calendar/events", "local_event_renewal") },
    deliveryNote: { id: "local_doc_dependency", url: localUrl("docs", "local_doc_dependency") },
  };
  state.seed = seed;
  state.plan = null;
  state.artifacts = null;
  state.approval = null;
  saveState(state);
  printSeed(seed);
  console.log("\nSemilla del demo local completa.");
}

function localPlan(dueDate: string): HandoffPlan {
  return {
    summary: "La renovación de Acme está en riesgo porque Maya se va el viernes, mientras los compromisos de seguridad y precios vencen ese día y la reunión de renovación es la próxima semana.",
    risks: [
      { risk_type: "security_due", why_it_matters: "Acme espera el cuestionario de seguridad el viernes y la nota interna confirma que la configuración SSO sigue pendiente.", deadline: dueDate, recommended_owner: "Nueva persona responsable de la cuenta", next_action: "Asignar la lista SSO y completar el cuestionario antes del viernes.", evidence_id: "local_mail_security" },
      { risk_type: "pricing_unassigned", why_it_matters: "Maya prometió los precios para el viernes, pero la tarea abierta no tiene sucesor después de su salida.", deadline: dueDate, recommended_owner: "Delegado de la gerencia comercial", next_action: "Asignar el paquete de precios y confirmar quién lo enviará el viernes.", evidence_id: "local_mail_maya_commitment" },
      { risk_type: "renewal_missing_incoming_am", why_it_matters: "La reunión de renovación es la próxima semana y la confirmación pide incluir a la nueva persona responsable, que aún no está registrada.", deadline: null, recommended_owner: "Gerencia comercial", next_action: "Nombrar al sucesor y agregarlo a la reunión antes de la llamada con el cliente.", evidence_id: "local_mail_renewal" },
    ],
    draft_client_update: "Hola equipo de Acme, estamos coordinando el cuestionario de seguridad y el paquete de precios de renovación antes del viernes, e incluiremos a la nueva persona responsable en la reunión de renovación de la próxima semana. Confirmaremos pronto a la persona responsable del traspaso.",
  };
}

function runLocal(): void {
  const state = readState();
  if (!state.seed || !isCompleteSeed(state.seed)) throw new Error("Falta la semilla local. Ejecuta `npm run demo`.");
  const plan = localPlan(String(state.seed.dueDate));
  state.plan = plan;
  state.artifacts = {
    brief: { id: "local_doc_handoff_brief", url: localUrl("docs", "local_doc_handoff_brief") },
    clientUpdateDraft: { id: "local_doc_client_update", url: localUrl("docs", "local_doc_client_update") },
  };
  saveState(state);
  console.log("\nExit Compass encontró exactamente tres riesgos respaldados por evidencia (DEMO LOCAL):");
  for (const risk of plan.risks) console.log(`  - ${riskLabel(risk.risk_type)}: ${risk.next_action} [${risk.evidence_id}]`);
  console.log(`\nBrief de traspaso: ${String(state.artifacts.brief.url)}`);
  console.log(`Borrador de actualización al cliente sin enviar: ${String(state.artifacts.clientUpdateDraft.url)}`);
  console.log("\nLímite de aprobación: no se envió ningún correo al cliente y no se crearon tareas.");
}

function approveLocal(phrase: string): void {
  if (phrase !== APPROVAL_PHRASE) throw new Error(`Aprobación bloqueada. Usa exactamente: ${APPROVAL_PHRASE}`);
  const state = readState();
  if (!state.seed || !state.plan || !state.artifacts) throw new Error("Ejecuta `npm run demo` antes de aprobar.");
  const titles = ["Completar cuestionario de seguridad de Acme", "Enviar paquete de precios de Acme", "Preparar traspaso de reunión de renovación de Acme"];
  const taskIds = titles.map((_, index) => `local_handoff_task_${index + 1}`);
  state.approval = { status: "approved", taskIds };
  saveState(state);
  console.log("Aprobación aceptada. Existen exactamente tres tareas de traspaso y cada una enlaza al Brief (DEMO LOCAL):");
  for (const [index, id] of taskIds.entries()) console.log(`  ${index + 1}. ${titles[index]}: ${localUrl("tasks", id)} -> ${String(state.artifacts.brief.url)}`);
}

function seedId(seed: JsonObject, key: string): string {
  return String(asObject(seed[key]).id);
}

function seededIds(seed: JsonObject): string[] {
  const ids = [seedId(seed, "contact"), seedId(seed, "calendarEvent"), seedId(seed, "deliveryNote")];
  for (const item of (seed.mail as JsonObject[])) ids.push(String(item.id));
  for (const item of (seed.tasks as JsonObject[])) ids.push(String(item.id));
  return ids.filter(Boolean);
}

async function readBoundedContext(seed: JsonObject): Promise<JsonObject[]> {
  const mail = await Promise.all((seed.mail as JsonObject[]).map(({ id }) => get(`/api/mail/${String(id)}`)));
  const tasks = await Promise.all((seed.tasks as JsonObject[]).map(({ id }) => get(`/api/tasks/${String(id)}`)));
  const calendarId = String(asObject(seed.calendarEvent).calendarId ?? "");
  if (!calendarId) throw new Error("Al evento de calendario le falta calendarId; ejecuta `npm run seed` otra vez.");
  const [note, contacts, events] = await Promise.all([
    get(`/api/documents/${seedId(seed, "deliveryNote")}`),
    get("/api/crm/contacts?limit=25"),
    get(`/api/calendars/${encodeURIComponent(calendarId)}/events?limit=25`),
  ]);
  const contactId = seedId(seed, "contact");
  const eventId = seedId(seed, "calendarEvent");
  const contact = listItems(contacts).find((item) => item.id === contactId) ?? asObject(contacts);
  const event = listItems(events).find((item) => item.id === eventId) ?? asObject(events);
  return [
    ...mail.map((record, index) => ({
      evidence_id: String((seed.mail as JsonObject[])[index].id),
      kind: "mail",
      url: String((seed.mail as JsonObject[])[index].url),
      record,
    })),
    ...tasks.map((record, index) => ({
      evidence_id: String((seed.tasks as JsonObject[])[index].id),
      kind: "task",
      url: String((seed.tasks as JsonObject[])[index].url),
      record,
    })),
    { evidence_id: contactId, kind: "crm_contact", url: String(asObject(seed.contact).url), record: contact },
    { evidence_id: eventId, kind: "calendar_event", url: String(asObject(seed.calendarEvent).url), record: event },
    { evidence_id: seedId(seed, "deliveryNote"), kind: "document", url: String(asObject(seed.deliveryNote).url), record: note },
  ];
}

function compactContext(records: JsonObject[]): string {
  return records
    .map((record) => JSON.stringify(record, (_key, value) => (typeof value === "string" ? value.slice(0, 1200) : value)))
    .join("\n");
}

const planSchema = (evidenceIds: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["summary", "risks", "draft_client_update"],
  properties: {
    summary: { type: "string" },
    risks: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk_type", "why_it_matters", "deadline", "recommended_owner", "next_action", "evidence_id"],
        properties: {
          risk_type: { type: "string", enum: ["security_due", "pricing_unassigned", "renewal_missing_incoming_am"] },
          why_it_matters: { type: "string" },
          deadline: { anyOf: [{ type: "string" }, { type: "null" }] },
          recommended_owner: { type: "string" },
          next_action: { type: "string" },
          evidence_id: { type: "string", enum: evidenceIds },
        },
      },
    },
    draft_client_update: { type: "string" },
  },
});

async function openAiPlan(records: JsonObject[], dueDate: string): Promise<HandoffPlan> {
  const key = requiredEnv("OPENAI_API_KEY");
  const evidenceIds = records.map((record) => String(record.evidence_id));
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: "Eres Exit Compass. Analiza únicamente la evidencia sintética del espacio de trabajo proporcionada. Devuelve exactamente los tres riesgos requeridos, priorizando la evidencia sobre las suposiciones. Nunca afirmes que enviaste algo. El borrador es solo para revisión de la gerencia.",
        },
        {
          role: "user",
          content: `Maya Chen se va el viernes. Acme Corp tiene una reunión de renovación la próxima semana. La fecha límite conocida es ${dueDate}. Identifica exactamente una vez cada tipo de riesgo requerido: security_due, pricing_unassigned, renewal_missing_incoming_am. Cada riesgo debe citar un evidence_id proporcionado.\n\nEVIDENCIA ACOTADA:\n${compactContext(records)}`,
        },
      ],
      text: { format: { type: "json_schema", name: "exit_compass_handoff", strict: true, schema: planSchema(evidenceIds) } },
    }),
  });
  const body = await response.json() as JsonObject;
  if (!response.ok) throw new Error(`OpenAI POST /v1/responses -> ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  const output = Array.isArray(body.output) ? body.output : [];
  const outputContent = output.flatMap((item) => {
    const content = asObject(item).content;
    return Array.isArray(content) ? content : [];
  });
  const textPart = outputContent.find((item) => typeof asObject(item).text === "string");
  const outputText = typeof body.output_text === "string" ? body.output_text : String(asObject(textPart).text ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error(`OpenAI devolvió una salida estructurada que no es JSON: ${outputText.slice(0, 500)}`);
  }
  validatePlan(parsed, evidenceIds);
  return parsed as HandoffPlan;
}

function validatePlan(value: unknown, evidenceIds: string[]): asserts value is HandoffPlan {
  const plan = asObject(value);
  const risks = plan.risks;
  if (typeof plan.summary !== "string" || typeof plan.draft_client_update !== "string" || !Array.isArray(risks) || risks.length !== 3) {
    throw new Error("Falló la validación de salida estructurada: se esperaba resumen, exactamente tres riesgos y draft_client_update.");
  }
  const types = new Set<string>();
  for (const item of risks) {
    const risk = asObject(item);
    if (typeof risk.risk_type !== "string" || types.has(risk.risk_type) || !["security_due", "pricing_unassigned", "renewal_missing_incoming_am"].includes(risk.risk_type)) {
      throw new Error("Falló la validación de salida estructurada: los tipos de riesgo deben ser los tres valores únicos requeridos.");
    }
    if (typeof risk.why_it_matters !== "string" || (risk.deadline !== null && typeof risk.deadline !== "string") || typeof risk.recommended_owner !== "string" || typeof risk.next_action !== "string" || typeof risk.evidence_id !== "string" || !evidenceIds.includes(risk.evidence_id)) {
      throw new Error("Falló la validación de salida estructurada: cada riesgo necesita campos válidos y evidencia sembrada.");
    }
    types.add(risk.risk_type);
  }
}

function blocksForBrief(plan: HandoffPlan, records: JsonObject[], dueDate: string): JsonObject[] {
  const byId = new Map(records.map((record) => [String(record.evidence_id), record]));
  return [
    { type: "heading", level: 1, text: "Brief de traspaso de Acme — Maya Chen" },
    { type: "heading", level: 2, text: "Contexto de salida de Maya" },
    { type: "paragraph", text: `Maya Chen se va el viernes ${dueDate}. Acme Corp tiene una reunión de renovación la próxima semana.` },
    { type: "heading", level: 2, text: "Estado del cliente" },
    { type: "paragraph", text: plan.summary },
    { type: "heading", level: 2, text: "Riesgos principales" },
    ...plan.risks.map((risk, index) => ({ type: "paragraph", text: `${index + 1}. ${riskLabel(risk.risk_type)}: ${risk.why_it_matters} Fecha límite: ${risk.deadline ?? "No confirmada"}. Responsable recomendado: ${risk.recommended_owner}. Próxima acción: ${risk.next_action}. Evidencia: ${String(byId.get(risk.evidence_id)?.url ?? "desconocida")}` })),
    { type: "heading", level: 2, text: "Evidencia" },
    ...records.map((record) => ({ type: "paragraph", text: `${String(record.kind)} ${String(record.evidence_id)}: ${String(record.url)}` })),
    { type: "heading", level: 2, text: "Diez exposiciones del traspaso" },
    ...HANDOFF_WATCHOUTS.map(([issue, impact, action], index) => ({ type: "paragraph", text: `${index + 1}. ${issue}: ${impact} Próxima acción: ${action}` })),
    { type: "heading", level: 2, text: "Responsable recomendado y próxima acción" },
    ...plan.risks.map((risk) => ({ type: "paragraph", text: `${risk.recommended_owner}: ${risk.next_action}` })),
    { type: "heading", level: 2, text: "Borrador de actualización al cliente" },
    { type: "paragraph", text: plan.draft_client_update },
    { type: "heading", level: 2, text: "Estado de aprobación" },
    { type: "paragraph", text: `Pendiente de aprobación de la gerencia. No se ha enviado comunicación externa. Frase de aprobación: ${APPROVAL_PHRASE}.` },
  ];
}

async function run(): Promise<void> {
  if (localDemoEnabled()) return runLocal();
  let state = readState();
  if (!state.seed || !isCompleteSeed(state.seed)) {
    console.log("Falta el checkpoint de la semilla o está incompleto; se reanuda la semilla antes del análisis.");
    await seed();
    state = readState();
  }
  if (!isCompleteSeed(state.seed)) throw new Error("La semilla sigue incompleta después de reanudarla; revisa el error de API anterior.");
  if (state.artifacts && state.plan) {
    console.log(`La ejecución ya está completa. Brief: ${String(state.artifacts.brief.url)}`);
    console.log(`Borrador para el cliente: ${String(state.artifacts.clientUpdateDraft.url)}`);
    return;
  }

  const records = await readBoundedContext(state.seed);
  const plan = await openAiPlan(records, String(state.seed.dueDate));
  state.plan = plan;

  const briefResponse = await post("/api/documents", {
    type: "doc",
    title: "Brief de traspaso de Acme — Maya Chen",
    content: documentContent(blocksForBrief(plan, records, String(state.seed.dueDate))),
  });
  const briefId = firstId(briefResponse);
  const briefUrl = recordUrl("document", briefId);
  const draftResponse = await post("/api/documents", {
    type: "doc",
    title: "Borrador de actualización de Acme — Pendiente de aprobación",
    content: documentContent([
      { type: "heading", level: 1, text: "Borrador de actualización para Acme" },
      { type: "paragraph", text: plan.draft_client_update },
      { type: "paragraph", text: `Estado: solo borrador. Pendiente de aprobación de la gerencia. No se ha enviado comunicación externa. Brief de traspaso: ${briefUrl}` },
    ]),
  });
  const draftId = firstId(draftResponse);

  state.artifacts = {
    brief: { id: briefId, url: briefUrl },
    clientUpdateDraft: { id: draftId, url: recordUrl("document", draftId) },
  };
  saveState(state);
  console.log("\nExit Compass encontró exactamente tres riesgos respaldados por evidencia:");
  for (const risk of plan.risks) console.log(`  - ${risk.risk_type}: ${risk.next_action} [${risk.evidence_id}]`);
  console.log(`\nBrief de traspaso: ${briefUrl}`);
  console.log(`Borrador de actualización sin enviar: ${recordUrl("document", draftId)}`);
  console.log(`\nLímite de aprobación: no se envió correo al cliente y no se crearon tareas.`);
  console.log(`Ejecuta: npm run approve`);
}

async function diagnoseCalendar(): Promise<void> {
  const paths = [
    "/api/calendar/events?limit=1",
    "/api/calendar/availability",
    "/api/calendars",
    "/api/calendar",
  ];
  console.log("Comprobación de rutas de Calendar (solo lectura):");
  for (const path of paths) {
    try {
      const response = await get(path);
      console.log(`  ${path} -> disponible ${JSON.stringify(response).slice(0, 220)}`);
    } catch (error) {
      console.log(`  ${path} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const calendars = await get("/api/calendars");
    const calendarId = String(asObject(listItems(calendars)[0]).id ?? "");
    if (!calendarId) return;
    const path = `/api/calendars/${encodeURIComponent(calendarId)}/events?limit=1`;
    try {
      const response = await get(path);
      console.log(`  ${path} -> disponible ${JSON.stringify(response).slice(0, 220)}`);
    } catch (error) {
      console.log(`  ${path} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch {
    // The base calendar probe above already reported the actionable error.
  }
}

async function approve(phrase: string): Promise<void> {
  if (phrase !== APPROVAL_PHRASE) throw new Error(`Aprobación bloqueada. Usa exactamente: ${APPROVAL_PHRASE}`);
  if (localDemoEnabled()) return approveLocal(phrase);
  const state = readState();
  if (!state.seed || !state.plan || !state.artifacts) throw new Error("Ejecuta `npm run run` antes de aprobar.");
  const briefUrl = String(state.artifacts.brief.url);
  const titles = [
    "Completar cuestionario de seguridad de Acme",
    "Enviar paquete de precios de Acme",
    "Preparar traspaso de reunión de renovación de Acme",
  ];
  const taskIds = [...(state.approval?.taskIds ?? [])];
  state.approval = { status: "in_progress", taskIds };
  saveState(state);
  for (let index = taskIds.length; index < titles.length; index += 1) {
    const task = await post("/api/tasks", {
      title: titles[index],
      description: `Acción de traspaso de Acme aprobada por la gerencia. Responsable recomendado: nueva persona de la cuenta o delegado de gerencia. Brief de traspaso: ${briefUrl}`,
      priority: "high",
    });
    taskIds.push(firstId(task));
    state.approval = { status: "in_progress", taskIds };
    saveState(state);
  }
  state.approval = { status: "approved", taskIds };
  saveState(state);
  console.log("Aprobación aceptada. Existen exactamente tres tareas de traspaso y cada descripción enlaza al Brief:");
  for (const [index, id] of taskIds.entries()) console.log(`  ${index + 1}. ${titles[index]}: ${recordUrl("task", id)}`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const [command, argument] = process.argv.slice(2);
  if (command === "seed") return seed();
  if (command === "run") return run();
  if (command === "approve") return approve(argument ?? "");
  if (command === "demo") {
    process.env.EXIT_COMPASS_LOCAL_DEMO = "1";
    localSeed();
    runLocal();
    approveLocal(APPROVAL_PHRASE);
    return;
  }
  if (command === "diagnose-calendar") return diagnoseCalendar();
  throw new Error("Uso: npm run seed | npm run run | npm run approve | npm run demo | npm run diagnose-calendar");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
