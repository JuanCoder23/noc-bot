'use strict';

// Extracted verbatim from the `Parsear Alerta` code node in
// workflows/NOC_bot.json. Kept byte-identical to what runs in n8n so the
// tests exercise the real logic, not a reimplementation of it.

// ════════════════════════════════════════════════════════════════
// RUNBOOK CATALOG
//
// The production deployment loads a private catalog of runbooks
// keyed by alert_type. The entries below are SYNTHETIC EXAMPLES
// written for this public repository: they show the shape the
// lookup expects, not any real operational procedure.
// ════════════════════════════════════════════════════════════════
const RUNBOOKS = {
  "RUNBOOK-001": {
    "id": "RUNBOOK-001",
    "nombre": "High CPU en servicio ECS",
    "alert_type": "ECS_CPU",
    "diagnostico": "EJEMPLO SINTETICO.\nConfirmar el servicio afectado a partir de las etiquetas de la alerta (service, cluster, region).\nRevisar la tendencia de CPU en el dashboard de infraestructura durante la ventana de la alerta.\nComparar running tasks contra desired tasks para descartar tareas que no arrancan.",
    "accion": "EJEMPLO SINTETICO.\nVerificar si el servicio tiene autoscaling configurado y si ya reaccionó.\nSi el autoscaling está activo, no escalar réplicas ni reiniciar tareas manualmente.\nSi el servicio está degradado, recoger logs y métricas antes de cualquier acción correctiva.",
    "escalamiento": "EJEMPLO SINTETICO.\nEscalar al siguiente nivel si la CPU permanece alta más allá de la ventana definida por el equipo, si hay tareas detenidas con error, o si el autoscaling no reaccionó.\nInformación a entregar: servicio, cluster, región, timestamp y duración de la alerta, y enlaces a las métricas relevantes."
  },
  "RUNBOOK-009": {
    "id": "RUNBOOK-009",
    "nombre": "Lambda Invocations Errors",
    "alert_type": "LAMBDA_ERROR",
    "diagnostico": "EJEMPLO SINTETICO.\nIdentificar la función afectada a partir de las etiquetas del monitor (service, env, region, functionname).\nDeterminar el alcance: una sola función o varias del mismo servicio o región.\nRevisar los logs de la función para clasificar el error (timeout, permisos, excepción no controlada, límite de recursos).",
    "accion": "EJEMPLO SINTETICO.\nValidar el estado de las dependencias a las que llama la función.\nConfirmar si hubo un despliegue o un cambio de configuración reciente que correlacione con el inicio de los errores.\nDocumentar tasa de error y tendencia antes de escalar.",
    "escalamiento": "EJEMPLO SINTETICO.\nEscalar al siguiente nivel si la tasa de error se sostiene por encima del umbral definido por el equipo, o si fallan varias funciones de la misma región o servicio.\nInformación a entregar: nombre y región de la función, tasa de error actual y su tendencia, y los mensajes de error predominantes."
  },
  "RUNBOOK-019": {
    "id": "RUNBOOK-019",
    "nombre": "RDS High Connections",
    "alert_type": "RDS_CONNECTIONS",
    "diagnostico": "EJEMPLO SINTETICO.\nComparar el número de conexiones activas contra el máximo configurado en la instancia.\nIdentificar qué servicios mantienen conexiones abiertas contra esa base de datos.\nRevisar si el crecimiento es gradual (posible fuga de conexiones) o un pico puntual (posible pico de tráfico).",
    "accion": "EJEMPLO SINTETICO.\nCorrelacionar el pico con despliegues recientes de los servicios consumidores.\nRevisar la configuración de pool de conexiones de los consumidores identificados.\nNo terminar conexiones ni reiniciar la instancia sin autorización del siguiente nivel.",
    "escalamiento": "EJEMPLO SINTETICO.\nEscalar al siguiente nivel si las conexiones superan la fracción del límite definida por el equipo, o si algún servicio ya reporta errores de conexión.\nInformación a entregar: identificador de la instancia, conexiones actuales contra el máximo, y los servicios consumidores identificados."
  },
};

const ALERT_TYPE_TO_RUNBOOK = {"ECS_CPU": "RUNBOOK-001", "ECS_MEMORY": "RUNBOOK-002", "ECS_STORAGE": "RUNBOOK-003", "ECS_HIGH_TASK": "RUNBOOK-004", "ECS_NETWORK": "RUNBOOK-005", "ALB_RESPONSE_TIME": "RUNBOOK-006", "PULSAR_BACKLOG": "RUNBOOK-007", "LAMBDA_INVOCATIONS": "RUNBOOK-008", "LAMBDA_ERROR": "RUNBOOK-009", "ECS_LOW_TASK": "RUNBOOK-010", "SQS_DLQ": "RUNBOOK-011", "SNOWFLAKE_ERROR": "RUNBOOK-012", "APM_LATENCY": "RUNBOOK-013", "APM_ERRORS": "RUNBOOK-014", "APIGW_4XX": "RUNBOOK-015", "FLAP_DETECTION": "RUNBOOK-016", "SYNTHETICS": "RUNBOOK-017", "AUTH0_TOKEN": "RUNBOOK-018", "RDS_CONNECTIONS": "RUNBOOK-019", "RDS_BLOCKING": "RUNBOOK-020", "ECS_GENERIC": "RUNBOOK-001"};

function lookupRunbook(parsed) {
  if (parsed.runbook && RUNBOOKS[parsed.runbook]) {
    return { id: parsed.runbook, ...RUNBOOKS[parsed.runbook], source: 'explicit' };
  }
  const autoId = ALERT_TYPE_TO_RUNBOOK[parsed.alert_type];
  if (autoId && RUNBOOKS[autoId]) {
    return { id: autoId, ...RUNBOOKS[autoId], source: 'auto_mapped' };
  }
  return null;
}

const KNOWN_RUNBOOKS = {
  'RUNBOOK-001': 'High CPU en servicio ECS',
  'RUNBOOK-002': 'High Memory servicio ECS',
  'RUNBOOK-003': 'Low Storage en contenedor ECS',
  'RUNBOOK-004': 'High Task Count servicio ECS',
  'RUNBOOK-005': 'Network Throughput anómalo ECS',
  'RUNBOOK-006': 'ALB Errors en servicio ECS',
  'RUNBOOK-007': 'Backlog en broker Pulsar',
  'RUNBOOK-008': 'Failed Lambda Invocations',
  'RUNBOOK-009': 'Lambda Invocations Errors',
  'RUNBOOK-010': 'Low Task Count servicio ECS',
  'RUNBOOK-011': 'Messages available on SQS DLQ',
  'RUNBOOK-012': 'Snowflake Query Errors',
  'RUNBOOK-013': 'APM High Latency',
  'RUNBOOK-014': 'APM High Errors',
  'RUNBOOK-015': 'API Gateway Errors',
  'RUNBOOK-016': 'Flap Detection - Monitor Inestable',
  'RUNBOOK-017': 'Synthetics Monitor Failure',
  'RUNBOOK-018': 'Auth0 Token / Authentication Failure',
  'RUNBOOK-019': 'RDS High Connections',
  'RUNBOOK-020': 'RDS Blocking Queries',
};

module.exports = { RUNBOOKS, ALERT_TYPE_TO_RUNBOOK, KNOWN_RUNBOOKS, lookupRunbook };
