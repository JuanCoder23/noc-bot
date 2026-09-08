'use strict';

// Extracted from the `Construir Mensaje Final` code node in
// workflows/NOC_bot.json. Renders the Slack reply from the enriched context
// and the model output. Takes the item payload directly instead of n8n's
// { json } envelope, and returns the message string.

function buildSlackMessage(j) {

  
  const ctx = j.enriched_context || {};
  const a = ctx.alert || {};
  const m = ctx.metrics || {};
  const l = ctx.logs || {};
  const e = ctx.events || {};
  const c = ctx.correlation || {};
  const h = ctx.aws_health || {};
  const rb = ctx.runbook;

  // =========================
  // 🧠 IA
  // =========================
  let aiAnalysis = '_(Sin análisis IA)_';
  const resp = j.claude_response || j.gemini_response || j.ai_response;

  if (resp) {
    if (resp.candidates?.[0]?.content?.parts) {
      aiAnalysis = resp.candidates[0].content.parts.map(p => p.text || '').join('').trim();
    } else if (resp.choices?.[0]?.message?.content) {
      aiAnalysis = resp.choices[0].message.content.trim();
    } else if (resp.content?.[0]?.text) {
      aiAnalysis = resp.content[0].text.trim();
    } else if (typeof resp === 'string') {
      aiAnalysis = resp.trim();
    }
  }

  // =========================
  // 🎯 STATUS
  // =========================
  const isCritical = a.state === 'TRIGGERED' || a.state === 'RE-TRIGGERED';
  const isRecovered = a.state === 'RECOVERED';

  const icon = isRecovered ? '🟢' : isCritical ? '🔴' : '🟡';

  const priorityBadge = {
    'P1':    '🔴 *[P1 — CRÍTICO]*',
    'P2':    '🟠 *[P2 — ELEVADO]*',
    'P3':    '🟡 *[P3]*',
    'NOISE': '🔕 *[NOISE]*'
  }[j.priority] || '🟡 *[P3]*';

  const escalateHeader = j.priority === 'P1'
    ? '\n🚨 *ESCALAR A N2 AHORA — Condición de umbral superada*'
    : '';

  const severity =
    a.severity === 'ALERT' ? 'CRÍTICO' :
    a.severity === 'WARN' ? 'ADVERTENCIA' :
    'OK';

  const typeLabel = (a.alert_type || 'UNKNOWN').replace(/_/g, ' ');
  const resource = Array.isArray(a.resource) ? a.resource.join(', ') : (a.resource || 'N/A');

  // =========================
  // 📊 METRICS
  // =========================
  const metricsBlock = m.available
    ? `\n*📊 Métricas (30 min)* → avg: \`${m.avg}\` | max: \`${m.max}\` | min: \`${m.min}\` | trend: \`${m.trend}\``
    : '';

  // =========================
  // 📜 LOGS (más limpio)
  // =========================
  let logsBlock = '';
  if (l.available && l.samples?.length) {
    const samples = l.samples.slice(0, 3);

    logsBlock = `\n*📜 Logs relevantes*`;

    logsBlock += samples.map(log => {
      const t = log.timestamp?.substring(11, 19) || '??:??:??';
      const msg = (log.message || '').replace(/\n/g, ' ').substring(0, 100);
      return `\n  • \`${t}\` ${msg}`;
    }).join('');
  }

  // =========================
  // 🚀 EVENTS
  // =========================
  let eventsBlock = '';
  if (e.available && (e.deploys?.length || e.changes?.length)) {
    eventsBlock = `\n*🚀 Cambios recientes*`;

    (e.deploys || []).slice(0, 2).forEach(d => {
      eventsBlock += `\n  • Deploy: ${(d.title || '').substring(0, 90)}`;
    });

    (e.changes || []).slice(0, 2).forEach(ch => {
      eventsBlock += `\n  • Change: ${(ch.title || '').substring(0, 90)}`;
    });
  }

  // =========================
  // 🔁 CORRELATION
  // =========================
  const correlationBlock = (c.available && c.similar_count > 0)
    ? `\n*🔁 Correlación:* ${c.similar_count} alerta(s) similar(es) en 1h ${c.similar_count >= 3 ? '⚠️ patrón' : ''}`
    : '';

  // =========================
  // ☁️ AWS HEALTH
  // =========================
  const healthBlock = h.available
    ? (h.incidents > 0
      ? `\n*☁️ AWS Health:* 🔴 ${h.incidents} incidente(s) activo(s)`
      : `\n*☁️ AWS Health:* 🟢 Sin incidentes`)
    : '';

  // =========================
  // 📖 RUNBOOK
  // =========================
  let runbookBlock = '';

  if (rb) {
    runbookBlock = `\n*📖 Runbook:* ${rb.id} — ${rb.nombre || ''}`;

    if (rb.diagnostico) {
      const steps = rb.diagnostico
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 4);

      if (steps.length) {
        runbookBlock += `\n*Checklist N1:*`;
        steps.forEach((s, i) => {
          runbookBlock += `\n  ☐ ${i + 1}. ${s.substring(0, 100)}`;
        });
      }
    }
  } else {
    runbookBlock = '\n*📖 Runbook:* _Sin runbook disponible para este tipo de alerta._';
  }

  const linkBlock = a.monitor_url
    ? `\n🔗 <${a.monitor_url}|Abrir monitor>`
    : '';

  // =========================
  // 🧠 FINAL MESSAGE (estructura tipo NOC)
  // =========================
  const message =
`${priorityBadge}  ${icon} *INCIDENTE AUTOMATIZADO N1*${escalateHeader}
━━━━━━━━━━━━━━━━━━━━━━
*Severidad:* ${severity}   *Estado:* ${a.state}
*Tipo:* ${typeLabel}
*Recurso:* ${resource}
*Región:* ${a.region || 'N/A'}
*Valor:* ${a.metric_value || 'N/A'}  |  Umbral: ${a.threshold || 'N/A'}
${metricsBlock}
${logsBlock}
${eventsBlock}
${correlationBlock}
${healthBlock}

*🧠 Análisis IA*
${aiAnalysis}

${runbookBlock}
${linkBlock}

_FYI:_ <@YOUR_SLACK_USER_ID>`;
  return message;
}

module.exports = { buildSlackMessage };
