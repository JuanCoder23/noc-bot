'use strict';

// Extracted verbatim from the `Parsear Alerta` code node in
// workflows/NOC_bot.json. Kept byte-identical to what runs in n8n so the
// tests exercise the real logic, not a reimplementation of it.

const { lookupRunbook, KNOWN_RUNBOOKS } = require('./runbooks');

function parseDatadogAlert(alertText) {
  const result = {
    alert_type: null,
    state: null,
    severity: null,
    metric_value: null,
    threshold: null,
    resource: null,
    resource_type: null,
    region: null,
    aws_account: null,
    runbook: null,
    runbook_name: null,
    monitor_url: null,
    dd_query: null,
    extra: {},
  };

  const text = (alertText || '').trim();
  const lower = text.toLowerCase();
  const firstLine = text.split('\n')[0].toLowerCase();
  /*
   * =========================
   * STATE + SEVERITY
   * =========================
   */

  if (firstLine.toLowerCase().includes('re-triggered')) {
    result.state = 'RE-TRIGGERED';
  } else if (firstLine.toLowerCase().includes('triggered')) {
    result.state = 'TRIGGERED';
  } else if (
    firstLine.toLowerCase().includes('recovered') ||
    firstLine.toLowerCase().includes('resolved')
  ) {
    result.state = 'RECOVERED';
  } else if (firstLine.toLowerCase().includes('warn')) {
    result.state = 'WARN';
  }

  if (result.state === 'RECOVERED') {
    result.severity = 'OK';
  } else if (
    result.state === 'TRIGGERED' ||
    result.state === 'RE-TRIGGERED'
  ) {
    result.severity = 'ALERT';
  } else {
    result.severity = 'WARN';
  }

  /*
   * =========================
   * GENERIC EXTRACTION
   * =========================
   */

  const regionM = text.match(/region:\s*([\w-]+)/i);
  if (regionM) {
    result.region = regionM[1];
  }

  const accountM = text.match(
    /(?:aws_account:|AWS Account(?:\s*(?:ID|Number)?)?|Account:)\s*(\d{9,12})/i
  );
  if (accountM) {
    result.aws_account = accountM[1];
  }

  const valueM = text.match(
    /(?:Value:|Metric value:|value:)\s*([\d.]+)/i
  );
  if (valueM) {
    result.metric_value = parseFloat(valueM[1]);
  }

  const thresholdM = text.match(
    />\s*(\d+(?:\.\d+)?)\s*(?:s\b|%\b|\b)/
  );
  if (thresholdM) {
    result.threshold = parseFloat(thresholdM[1]);
  }

  const runbookM = text.match(
    /(RUNBOOK-\d+)[:\s]*(.*?)(?:\n|@|$)/
  );
  if (runbookM) {
    result.runbook = runbookM[1];
    result.runbook_name =
      KNOWN_RUNBOOKS[runbookM[1]] ||
      (runbookM[2].trim() || 'Ver runbook');
  }

  const urlM = text.match(
    /(https:\/\/app\.datadoghq\.com\/monitors\/\d+[^\s]*)/
  );
  if (urlM) {
    result.monitor_url = urlM[1];
  }

  const queryM = text.match(
    /`((?:avg|sum|max|min)\([^`]+\))`/s
  );
  if (queryM) {
    result.dd_query = queryM[1];
  }

  /*
   * =========================
   * ALERT TYPE DETECTION
   * =========================
   */

  if (
    lower.includes('synthetics') ||
    lower.includes('monitor-type:synthetic')
  ) {
    result.alert_type = 'SYNTHETICS';
    result.resource_type = 'service';

    const svcM = text.match(
      /The service ([\w\-]+) is down/i
    );

    result.resource = svcM ? svcM[1] : 'unknown';
  }

  else if (
    lower.includes('lambda') ||
    lower.includes('functionname:')
  ) {
    result.alert_type = 'LAMBDA_ERROR';
    result.resource_type = 'functionname';

    const fnM = text.match(
      /(?:Function Name:|functionname:)\s*([\w\-]+)/i
    );

    result.resource = fnM
      ? fnM[1].replace(/\}+$/, '')
      : null;
  }

  else if (
    lower.includes('auth0') ||
    lower.includes('access token')
  ) {
    result.alert_type = 'AUTH0_TOKEN';
    result.resource_type = 'service';
    result.resource = 'auth0';
  }

  else if (
    text.includes('queuename:') ||
    lower.includes('dead-letter') ||
    lower.includes('dlq')
  ) {
    result.alert_type = 'SQS_DLQ';
    result.resource_type = 'queuename';

    const qM = text.match(
      /(?:Queue:|queuename:)\s*([\w\-]+)/i
    );

    result.resource = qM ? qM[1] : null;
  }

  else if (
    text.includes('loadbalancer:') ||
    text.includes('Load Balancer:')
  ) {
    result.alert_type = 'ALB_RESPONSE_TIME';
    result.resource_type = 'loadbalancer';

    const lbM = text.match(
      /(?:Load Balancer:|loadbalancer:)\s*([\w/\-]+)/i
    );

    result.resource = lbM ? lbM[1] : null;
  }

  else if (text.includes('database_instance:')) {
    result.alert_type = 'RDS_CONNECTIONS';
    result.resource_type = 'database_instance';

    const dbM = text.match(
      /database_instance:([\w.\-]+)/i
    );

    result.resource = dbM ? dbM[1] : null;
  }

  else if (
    lower.includes('blocking') &&
    (lower.includes('rds') || lower.includes('host:'))
  ) {
    result.alert_type = 'RDS_BLOCKING';
    result.resource_type = 'host';

    const hostM = text.match(
      /host:\s*([\w.\-]+)/i
    );

    result.resource = hostM ? hostM[1] : null;
  }

  else if (
    (lower.includes('pulsar') ||
    lower.includes('backlog')) &&
    !lower.includes('high memory') &&
    !lower.includes('memory_utilization') &&
    !lower.includes('high cpu') &&
    !lower.includes('ecs cluster')
  ) {
    result.alert_type = 'PULSAR_BACKLOG';
    result.resource_type = 'subscription';

    const subs = [
      ...text.matchAll(/([\w\-]+)\s*\|\s*([\d.]+)/g),
    ];

    if (subs.length > 0) {
      result.resource = subs[0][1];

      result.extra.subscriptions = subs.map((s) => ({
        name: s[1],
        value: parseFloat(s[2]),
      }));

      result.metric_value = Math.max(
        ...subs.map((s) => parseFloat(s[2]))
      );
    }
  }

  else if (
    text.includes('apiname:') ||
    lower.includes('api gateway')
  ) {
    result.alert_type = 'APIGW_4XX';
    result.resource_type = 'apiname';

    const apiM = text.match(
      /(?:API Gateway:|apiname:)\s*([\w\-]+)/i
    );

    result.resource = apiM ? apiM[1] : null;
  }

  /*
   * ECS CPU
   */

  else if (
    lower.includes('high cpu') ||
    lower.includes('ecs.cpu')
  ) {
    result.alert_type = 'ECS_CPU';
    result.resource_type = 'servicename';

    const tagsM = text.match(/Tags[\s\S]*?\n((?:(?!\n\n)[\s\S])*)/);
    const tagsText = tagsM ? tagsM[1] : '';
    const svcSource = tagsText.includes('servicename:') ? tagsText : text;
    let svcs = [
      ...new Set(
        [...svcSource.matchAll(/servicename:([\w\-]+)/gi)].map(
          (m) => m[1]
        )
      ),
    ];

    if (svcs.length === 0) {
      const hostM = text.match(
        /Host:\s*([\w\-]+)/i
      );

      if (hostM) {
        svcs = [hostM[1]];
      }
    }

    result.resource =
      svcs[0] || null;
  }

  /*
   * ECS MEMORY
   */

  else if (
    lower.includes('high memory') ||
    lower.includes('memory_utilization')
  ) {
    result.alert_type = 'ECS_MEMORY';
    result.resource_type = 'servicename';

    const tagsM = text.match(/Tags[\s\S]*?\n((?:(?!\n\n)[\s\S])*)/);
    const tagsText = tagsM ? tagsM[1] : '';
    const svcSource = tagsText.includes('servicename:') ? tagsText : text;
    let svcs = [
      ...new Set(
        [...svcSource.matchAll(/servicename:([\w\-]+)/gi)].map(
          (m) => m[1]
        )
      ),
    ];

    if (svcs.length === 0) {
      const hostM = text.match(
        /Host:\s*([\w\-]+)/i
      );

      if (hostM) {
        svcs = [hostM[1]];
      }
    }

    result.resource =
      svcs[0] || null;
  }

  /*
   * ECS GENERIC
   */

  else if (
    text.includes('servicename:') ||
    lower.includes('ecs')
  ) {
    result.alert_type = 'ECS_GENERIC';
    result.resource_type = 'servicename';

    const tagsM = text.match(/Tags[\s\S]*?\n((?:(?!\n\n)[\s\S])*)/);
    const tagsText = tagsM ? tagsM[1] : '';
    const svcSource = tagsText.includes('servicename:') ? tagsText : text;
    let svcs = [
      ...new Set(
        [...svcSource.matchAll(/servicename:([\w\-]+)/gi)].map(
          (m) => m[1]
        )
      ),
    ];

    if (svcs.length === 0) {
      const hostM = text.match(
        /Host:\s*([\w\-]+)/i
      );

      if (hostM) {
        svcs = [hostM[1]];
      }
    }

    result.resource =
      svcs[0] || null;
  }

  return result;
}

function buildDDQuery(parsed) {
  if (parsed.dd_query) {
    const cleanQuery = parsed.dd_query
      .replace(
        /^(?:sum|avg|max|min)\(last_\d+[smh]\):/,
        ''
      )
      .replace(/\.as_count\(\)$/, '')
      .replace(/\s+by\s+\{[^}]+\}/, '');

    return cleanQuery;
  }

  const resource = parsed.resource;
  const r =
    Array.isArray(resource) && resource.length > 0
      ? resource[0]
      : (resource || '');
    if (!r) return null;
  

  const queries = {
    ECS_CPU:
      `avg:aws.ecs.cpuutilization{servicename:${r}}`,

    ECS_MEMORY:
      `avg:aws.ecs.memory_utilization{servicename:${r}}`,

    SQS_DLQ:
      `avg:aws.sqs.approximate_number_of_messages_visible{queuename:${r}}`,

    ALB_RESPONSE_TIME:
      `avg:aws.applicationelb.target_response_time.average{loadbalancer:${r}}`,

    RDS_CONNECTIONS:
      `avg:aws.rds.database_connections{database_instance:${r}}`,

    APIGW_4XX:
      `sum:aws.apigateway.4xxerror{apiname:${r}}`,

    LAMBDA_ERROR:
      `sum:aws.lambda.errors{functionname:${r}}`,
      ECS_STORAGE:
              `avg:aws.ecs.storage.read_bytes{servicename:${r}}`,
  
      ECS_HIGH_TASK:
              `avg:aws.ecs.service.running_count{servicename:${r}}`,
  
      ECS_NETWORK:
              `avg:aws.ecs.service.running_count{servicename:${r}}`,
  
      ECS_GENERIC:
              `avg:aws.ecs.cpuutilization{servicename:${r}}`,
  
      LAMBDA_INVOCATIONS:
              `sum:aws.lambda.invocations{functionname:${r}}`,
  
      RDS_BLOCKING:
              `avg:aws.rds.queries{database_instance:${r}}`,
  
      APM_LATENCY:
              `avg:trace.web.request.duration{service:${r}}`,
  
      APM_ERRORS:
              `sum:trace.web.request.errors{service:${r}}`,
  
      PULSAR_BACKLOG:
              `avg:pulsar.producer.msg_rate_in{topic:${r}}`,
  
      SNOWFLAKE_ERROR:
              `sum:snowflake.query.execution_count{warehouse:${r}}`,
  
      AUTH0_TOKEN:
              `sum:auth0.logins_count{connection:${r}}`,
  
      SYNTHETICS: null,
  
  };

  return queries[parsed.alert_type] || null;
}

function buildLogsQuery(parsed) {
  const r = Array.isArray(parsed.resource)
    ? parsed.resource[0]
    : (parsed.resource || '');

  if (!r) return null;

  const queries = {
    LAMBDA_ERROR:
      `service:${r} status:error`,

    ECS_CPU:
      `servicename:${r} status:error`,

    ECS_MEMORY:
      `servicename:${r} status:error`,

    APIGW_4XX:
      `apiname:${r} @http.status_code:[400 TO 499]`,

    AUTH0_TOKEN:
      `service:auth0 status:error`,

    RDS_CONNECTIONS:
      `host:${r} status:(error OR warn)`,

    RDS_BLOCKING:
      `host:${r} (blocking OR deadlock)`,

    SQS_DLQ:
      `queuename:${r}`,

    ALB_RESPONSE_TIME:
      `loadbalancer:${r} @http.status_code:[500 TO 599]`,
  };

  return (
    queries[parsed.alert_type] ||
    `${parsed.resource_type || ''}:${r}`.replace(/^:/, '')
  );
}

module.exports = { parseDatadogAlert, buildDDQuery, buildLogsQuery, lookupRunbook };
