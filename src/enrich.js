'use strict';

// Extracted from the `Procesar Enriquecimiento` code node in
// workflows/NOC_bot.json, minus the n8n item-mapping wrapper.
//
// Every summarizer returns { available: false } when its input is missing or
// empty, and the prompt builder omits the corresponding section. A failed
// enrichment call and an empty result are therefore indistinguishable here by
// design — that is what lets the pipeline degrade instead of fail.


function summarizeMetrics(seriesData) {
  if (!seriesData || !seriesData.series || seriesData.series.length === 0) {
    return { available: false };
  }
  const points = seriesData.series[0].pointlist || [];
  const values = points.map(p => p[1]).filter(v => v !== null && !isNaN(v));
  if (values.length === 0) return { available: false };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const firstHalf = values.slice(0, Math.floor(values.length / 2));
  const secondHalf = values.slice(Math.floor(values.length / 2));
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / (firstHalf.length || 1);
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / (secondHalf.length || 1);
  let trend = 'estable';
  if (avgSecond > avgFirst * 1.2) trend = 'subiendo ↗';
  else if (avgSecond < avgFirst * 0.8) trend = 'bajando ↘';
  return {
    available: true,
    avg: parseFloat(avg.toFixed(2)),
    max: parseFloat(max.toFixed(2)),
    min: parseFloat(min.toFixed(2)),
    trend,
    points_count: values.length,
  };
}

function summarizeLogs(logsData) {
  if (!logsData || !logsData.data || logsData.data.length === 0) {
    return { available: false, count: 0, samples: [] };
  }
  const logs = logsData.data.slice(0, 5);
  const samples = logs.map(l => {
    const attrs = l.attributes || {};
    const msg = (attrs.message || '').substring(0, 200);
    const ts = attrs.timestamp || '';
    const status = attrs.status || '';
    const service = attrs.service || '';
    return { timestamp: ts, status, service, message: msg };
  });
  return {
    available: true,
    count: logsData.data.length,
    samples,
  };
}

function summarizeEvents(eventsData) {
  if (!eventsData || !eventsData.events || eventsData.events.length === 0) {
    return { available: false, deploys: [], changes: [] };
  }
  const deploys = [];
  const changes = [];
  for (const ev of eventsData.events.slice(0, 10)) {
    const title = (ev.title || '').toLowerCase();
    const text = (ev.text || '').substring(0, 200);
    const item = {
      title: ev.title || '',
      text,
      date: ev.date_happened ? new Date(ev.date_happened * 1000).toISOString() : null,
      tags: ev.tags || [],
    };
    if (title.includes('deploy') || title.includes('release')) deploys.push(item);
    else changes.push(item);
  }
  return {
    available: true,
    deploys: deploys.slice(0, 3),
    changes: changes.slice(0, 3),
  };
}

function summarizeCorrelation(slackHistoryData, parsed) {
  if (!slackHistoryData || !Array.isArray(slackHistoryData) || slackHistoryData.length === 0) {
    return { available: false, similar_count: 0 };
  }
  const resource = parsed.resource;
  const r = Array.isArray(resource) ? resource[0] : (resource || '');
  const alertType = (parsed.alert_type || '').toLowerCase();
  let similarCount = 0;
  const samples = [];
  for (const msg of slackHistoryData) {
    const txt = (msg.text || msg.json?.text || '').toLowerCase();
    if (!txt) continue;
    const matchesResource = r && txt.includes(r.toLowerCase());
    const matchesType = alertType && (
      txt.includes(alertType.replace(/_/g, ' ')) ||
      (alertType === 'lambda_error' && txt.includes('lambda')) ||
      (alertType === 'ecs_cpu' && txt.includes('cpu')) ||
      (alertType === 'ecs_memory' && txt.includes('memory'))
    );
    if (matchesResource || matchesType) {
      similarCount++;
      if (samples.length < 3) {
        samples.push((msg.text || msg.json?.text || '').substring(0, 100));
      }
    }
  }
  return {
    available: true,
    similar_count: similarCount,
    samples,
  };
}

function buildClaudePrompt(ctx) {
  const a = ctx.alert;
  const m = ctx.metrics;
  const l = ctx.logs;
  const e = ctx.events;
  const c = ctx.correlation;
  const h = ctx.aws_health;

  const resource = Array.isArray(a.resource) ? a.resource.join(', ') : a.resource;

  let prompt = `ALERTA:\nTipo: ${a.alert_type} | Estado: ${a.state} | Recurso: ${resource || 'N/A'} | Región: ${a.region || 'N/A'}\nValor: ${a.metric_value || 'N/A'} | Umbral: ${a.threshold || 'N/A'}\n`;

  if (m.available) {
    prompt += `\nMÉTRICAS (30 min): avg=${m.avg} | max=${m.max} | min=${m.min} | trend=${m.trend}`;
  } else {
    prompt += '\nMÉTRICAS: No disponibles para este tipo de alerta.';
  }

  if (l.available && l.samples.length > 0) {
    prompt += `\n\nLOGS (${l.count} eventos, últimos 15 min):`;
    l.samples.slice(0, 3).forEach(log => {
      const t = (log.timestamp || '').substring(11, 19) || '??:??:??';
      const msg = (log.message || '').replace(/\n/g, ' ').substring(0, 150);
      prompt += `\n• [${t}] [${log.status || 'log'}] ${msg}`;
    });
  }

  if (e.available && e.deploys.length > 0) {
    prompt += '\n\nDEPLOYS/CAMBIOS RECIENTES:';
    e.deploys.slice(0, 2).forEach(d => { prompt += `\n• ${(d.title || '').substring(0, 100)}`; });
  }

  if (c.available && c.similar_count > 0) {
    prompt += `\n\nCORRELACIÓN: ${c.similar_count} alerta(s) similar(es) en la última hora${c.similar_count >= 3 ? ' ⚠️ patrón recurrente' : ''}.`;
  }

  if (h.available) {
    prompt += h.incidents > 0
      ? `\n\nAWS HEALTH: ⚠️ ${h.incidents} incidente(s) activo(s) en la región.`
      : '\n\nAWS HEALTH: Sin incidentes activos.';
  }

  if (ctx.runbook) {
    prompt += `\n\nRunbook aplicable identificado: ${ctx.runbook.id} — ${ctx.runbook.nombre}`;
  }

  return prompt;
}

/** Assemble the enrichment payload the prompt is built from. */
function buildEnrichedContext(j) {
  return {
    alert: j.parsed || {},
    metrics: summarizeMetrics(j.dd_metrics_response),
    logs: summarizeLogs(j.dd_logs_response),
    events: summarizeEvents(j.dd_events_response),
    correlation: summarizeCorrelation(j.slack_history_response, j.parsed || {}),
    aws_health: j.aws_health_summary || { available: false, incidents: 0 },
    runbook: j.runbook_detail || null,
  };
}

module.exports = {
  summarizeMetrics,
  summarizeLogs,
  summarizeEvents,
  summarizeCorrelation,
  buildEnrichedContext,
  buildClaudePrompt,
};
