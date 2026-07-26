const crypto = require('node:crypto');

const JSON_TYPE = 'application/json';
const MAX_BODY_BYTES = 16 * 1024;
const ENDPOINT_TIMEOUT_MS = 27 * 1000;
const TOKEN_TIMEOUT_MS = 5 * 1000;
const CRM_TIMEOUT_MS = 6 * 1000;
const MAX_ZOHO_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const TOKEN_EXPIRY_SAFETY_MS = 5 * 60 * 1000;
const TOKEN_CACHE_KEY = 'zoho-access-token-v1';
const ALLOWED_BILL_RANGES = new Set([
  'Below ₹2,000',
  '₹2,000 – ₹5,000',
  '₹5,000 – ₹10,000',
  '₹10,000 – ₹20,000',
  'Above ₹20,000',
]);

const FIELD = Object.freeze({
  lastName: 'Last_Name',
  phone: 'Phone',
  websiteSubmissionId: 'Website_Submission_ID',
  city: 'City',
  billRange: 'Monthly_EB_Bill_Range',
  leadSource: 'Lead_Source',
  leadStatus: 'Lead_Status',
  utmSource: 'UTM_Source',
  utmMedium: 'UTM_Medium',
  utmCampaign: 'UTM_Campaign',
  utmContent: 'UTM_Content',
  utmTerm: 'UTM_Term',
  landingPageUrl: 'Landing_Page_URL',
  googleClickId: 'Google_Click_ID',
  facebookClickId: 'Facebook_Click_ID',
});

let localTokenCache = globalThis.__vishanZohoToken || null;
let tokenRefreshPromise = globalThis.__vishanZohoTokenRefresh || null;

function reply(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function safeString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeIndianPhone(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input || /[^\d+\s()-]/.test(input) || (input.match(/\+/g) || []).length > 1 || (input.includes('+') && !input.startsWith('+'))) return '';
  let digits = input.replace(/\D/g, '');
  if (/^0?91[6-9]\d{9}$/.test(digits)) digits = digits.replace(/^0?91/, '');
  if (!/^[6-9]\d{9}$/.test(digits)) return '';
  return `+91${digits}`;
}

function safeUrl(value) {
  const text = safeString(value, 2048);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && Buffer.byteLength(req.body) <= MAX_BODY_BYTES) return JSON.parse(req.body);
  throw new Error('INVALID_BODY');
}

function validate(body) {
  const lead = {
    fullName: safeString(body.fullName, 80),
    phone: normalizeIndianPhone(body.phone),
    billRange: safeString(body.billRange, 80),
    location: safeString(body.location, 255),
    honeypot: safeString(body.companyWebsite, 200),
    submissionId: safeString(body.idempotencyKey, 80),
    attribution: {
      utmSource: safeString(body.attribution?.utm_source, 255),
      utmMedium: safeString(body.attribution?.utm_medium, 255),
      utmCampaign: safeString(body.attribution?.utm_campaign, 255),
      utmContent: safeString(body.attribution?.utm_content, 255),
      utmTerm: safeString(body.attribution?.utm_term, 255),
      gclid: safeString(body.attribution?.gclid, 255),
      fbclid: safeString(body.attribution?.fbclid, 255),
      landingPageUrl: safeUrl(body.attribution?.landing_page_url),
      referrer: safeUrl(body.attribution?.referrer),
    },
  };
  if (lead.honeypot) return { error: 'SPAM_REJECTED' };
  if (!lead.fullName) return { error: 'INVALID_NAME' };
  if (!/^\+91[6-9]\d{9}$/.test(lead.phone)) return { error: 'INVALID_PHONE' };
  if (!ALLOWED_BILL_RANGES.has(lead.billRange)) return { error: 'INVALID_BILL_RANGE' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lead.submissionId)) return { error: 'INVALID_IDEMPOTENCY_KEY' };
  return { lead };
}

function requiredEnv() {
  const names = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ACCOUNTS_URL', 'ZOHO_API_DOMAIN'];
  const values = {};
  for (const name of names) {
    if (!process.env[name]) throw new Error(`MISSING_${name}`);
    values[name] = process.env[name].replace(/\/+$/, '');
  }
  return values;
}

function nowMs() {
  return performance.now();
}

function remainingTimeout(deadline, requestedMs) {
  return Math.max(1, Math.min(requestedMs, deadline - Date.now()));
}

async function fetchWithTimeout(url, options, timeoutMs, deadline = Date.now() + timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingTimeout(deadline, timeoutMs));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function runtimeCache() {
  try {
    return require('@vercel/functions').getCache({ namespace: 'vishan-solar-crm' });
  } catch {
    return null;
  }
}

function validToken(entry) {
  return Boolean(entry?.token && Number(entry.expiresAt) - Date.now() > TOKEN_EXPIRY_SAFETY_MS);
}

function transientStatus(status) {
  return status === 429 || [500, 502, 503, 504].includes(status);
}

function sleep(ms, deadline) {
  const delay = Math.min(ms, Math.max(0, deadline - Date.now() - 1));
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function zohoError(code, status, retryable = false, details = {}) {
  const error = new Error(code);
  error.zohoStatus = status;
  error.retryable = retryable;
  Object.assign(error, details);
  return error;
}

function logEvent(level, event, context, fields = {}) {
  console[level](event, {
    timestamp: new Date().toISOString(),
    requestId: context.requestId,
    websiteSubmissionId: context.submissionId,
    phone: context.phone,
    ...fields,
  });
}

function sanitizedFailure(error) {
  if (error?.name === 'AbortError') return 'TIMEOUT';
  if (error instanceof TypeError) return 'NETWORK_FAILURE';
  const allowed = new Set([
    'ZOHO_AUTH_EXPIRED', 'ZOHO_AUTH_FAILED', 'ZOHO_CREATE_FAILED',
    'ZOHO_VERIFY_FAILED', 'ZOHO_IDEMPOTENCY_NOT_CONFIRMED',
  ]);
  if (allowed.has(error?.message) || error?.message?.startsWith('MISSING_')) return error.message;
  return 'INTERNAL_FAILURE';
}

async function refreshAccessToken(env, deadline, context) {
  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  let lastError;
  for (let attempt = 1; attempt <= MAX_ZOHO_ATTEMPTS; attempt += 1) {
    const started = nowMs();
    try {
      const response = await fetchWithTimeout(`${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      }, TOKEN_TIMEOUT_MS, deadline);
      const data = await response.json().catch(() => ({}));
      logEvent(response.ok ? 'info' : 'warn', 'zoho_operation', context, {
        attempt, operation: 'token-refresh', zohoStatus: response.status,
        durationMs: Math.round(nowMs() - started),
        failureReason: response.ok ? null : 'TOKEN_REFRESH_REJECTED',
      });
      if (response.ok && typeof data.access_token === 'string') return data;
      lastError = zohoError('ZOHO_AUTH_FAILED', response.status, transientStatus(response.status));
      if (!lastError.retryable || attempt >= MAX_ZOHO_ATTEMPTS) throw lastError;
    } catch (error) {
      lastError = error;
      if (error.message !== 'ZOHO_AUTH_FAILED') {
        logEvent('warn', 'zoho_operation', context, {
          attempt, operation: 'token-refresh', zohoStatus: null,
          durationMs: Math.round(nowMs() - started), failureReason: error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_FAILURE',
        });
      }
      if ((!error.retryable && error.name !== 'AbortError' && !(error instanceof TypeError)) || attempt >= MAX_ZOHO_ATTEMPTS) throw error;
    }
    await sleep(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)), deadline);
  }
  throw lastError;
}

async function clearAccessToken() {
  localTokenCache = null;
  globalThis.__vishanZohoToken = null;
  const cache = runtimeCache();
  if (cache) {
    try { await cache.delete(TOKEN_CACHE_KEY); } catch { console.warn('zoho_token_cache_delete_failed'); }
  }
}

async function getAccessToken(env, deadline, context, forceRefresh = false) {
  if (forceRefresh) await clearAccessToken();
  if (validToken(localTokenCache)) return { token: localTokenCache.token, source: 'memory' };
  const cache = runtimeCache();
  if (cache) {
    try {
      const shared = await cache.get(TOKEN_CACHE_KEY);
      if (validToken(shared)) {
        localTokenCache = shared;
        globalThis.__vishanZohoToken = shared;
        return { token: shared.token, source: 'runtime-cache' };
      }
    } catch { console.warn('zoho_token_cache_unavailable'); }
  }
  if (tokenRefreshPromise) return tokenRefreshPromise;
  tokenRefreshPromise = (async () => {
    const data = await refreshAccessToken(env, deadline, context);
    const expiresInSeconds = Math.max(600, Number(data.expires_in) || 3600);
    const entry = { token: data.access_token, expiresAt: Date.now() + expiresInSeconds * 1000 };
    localTokenCache = entry;
    globalThis.__vishanZohoToken = entry;
    if (cache) {
      try {
        await cache.set(TOKEN_CACHE_KEY, entry, {
          ttl: Math.max(60, expiresInSeconds - TOKEN_EXPIRY_SAFETY_MS / 1000),
          tags: ['zoho-auth'], name: 'Zoho CRM access token',
        });
      } catch { console.warn('zoho_token_cache_write_failed'); }
    }
    return { token: entry.token, source: 'refresh' };
  })();
  globalThis.__vishanZohoTokenRefresh = tokenRefreshPromise;
  try { return await tokenRefreshPromise; } finally {
    tokenRefreshPromise = null;
    globalThis.__vishanZohoTokenRefresh = null;
  }
}

async function zohoRequest(env, token, path, options, deadline) {
  return fetchWithTimeout(`${env.ZOHO_API_DOMAIN}/crm/v8${path}`, {
    ...options,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': JSON_TYPE,
      ...(options.headers || {}),
    },
  }, CRM_TIMEOUT_MS, deadline);
}

function crmRecord(lead) {
  const record = {
    [FIELD.lastName]: lead.fullName,
    [FIELD.phone]: lead.phone,
    [FIELD.websiteSubmissionId]: lead.submissionId,
    [FIELD.billRange]: lead.billRange,
    [FIELD.leadSource]: 'Advertisement',
    [FIELD.leadStatus]: 'Not Contacted',
  };
  const optional = [
    [FIELD.city, lead.location],
    [FIELD.utmSource, lead.attribution.utmSource],
    [FIELD.utmMedium, lead.attribution.utmMedium],
    [FIELD.utmCampaign, lead.attribution.utmCampaign],
    [FIELD.utmContent, lead.attribution.utmContent],
    [FIELD.utmTerm, lead.attribution.utmTerm],
    [FIELD.landingPageUrl, lead.attribution.landingPageUrl],
    [FIELD.googleClickId, lead.attribution.gclid],
    [FIELD.facebookClickId, lead.attribution.fbclid],
  ];
  for (const [field, value] of optional) if (value) record[field] = value;
  return record;
}

async function verifySubmission(env, token, lead, leadId, deadline) {
  const path = leadId
    ? `/Leads/${encodeURIComponent(leadId)}?fields=id,${FIELD.websiteSubmissionId}`
    : `/Leads/search?criteria=${encodeURIComponent(`(${FIELD.websiteSubmissionId}:equals:${lead.submissionId})`)}&fields=id,${FIELD.websiteSubmissionId}&per_page=1`;
  const response = await zohoRequest(env, token, path, { method: 'GET' }, deadline);
  if (response.status === 401) throw zohoError('ZOHO_AUTH_EXPIRED', 401);
  if (!response.ok) throw zohoError('ZOHO_VERIFY_FAILED', response.status, transientStatus(response.status));
  const data = await response.json().catch(() => ({}));
  const record = data.data?.[0];
  if (!record?.id || record[FIELD.websiteSubmissionId] !== lead.submissionId) throw zohoError('ZOHO_IDEMPOTENCY_NOT_CONFIRMED', response.status);
  return record.id;
}

async function createLead(env, token, lead, deadline) {
  const response = await zohoRequest(env, token, '/Leads', {
    method: 'POST',
    body: JSON.stringify({ data: [crmRecord(lead)], trigger: ['workflow'] }),
  }, deadline);
  const data = await response.json().catch(() => ({}));
  const result = data.data?.[0];
  if (response.ok && result?.status === 'success' && result?.details?.id) {
    return { created: true, idempotentReplay: false, leadId: result.details.id, status: response.status };
  }
  if (result?.code === 'DUPLICATE_DATA') {
    return { created: false, idempotentReplay: true, leadId: result.details?.id || null, status: response.status };
  }
  throw zohoError(response.status === 401 ? 'ZOHO_AUTH_EXPIRED' : 'ZOHO_CREATE_FAILED', response.status, transientStatus(response.status));
}

async function submitLead(lead, deadline, context) {
  const env = requiredEnv();
  let access = await getAccessToken(env, deadline, context);
  let lastError;
  for (let attempt = 1; attempt <= MAX_ZOHO_ATTEMPTS; attempt += 1) {
    const started = nowMs();
    try {
      const result = await createLead(env, access.token, lead, deadline);
      if (result.idempotentReplay) result.leadId = await verifySubmission(env, access.token, lead, result.leadId, deadline);
      logEvent('info', 'zoho_operation', context, {
        attempt, operation: result.idempotentReplay ? 'idempotent-existing' : 'create',
        zohoStatus: result.status, zohoLeadId: result.leadId,
        created: result.created, idempotentReplay: result.idempotentReplay,
        durationMs: Math.round(nowMs() - started), failureReason: null,
      });
      return result;
    } catch (error) {
      lastError = error;
      const networkFailure = error.name === 'AbortError' || error instanceof TypeError;
      logEvent('warn', 'zoho_operation', context, {
        attempt, operation: 'create', zohoStatus: error.zohoStatus || null,
        durationMs: Math.round(nowMs() - started),
        failureReason: sanitizedFailure(error),
      });
      if (error.message === 'ZOHO_AUTH_EXPIRED' && attempt < MAX_ZOHO_ATTEMPTS) {
        access = await getAccessToken(env, deadline, context, true);
      } else if ((!error.retryable && !networkFailure) || attempt >= MAX_ZOHO_ATTEMPTS) {
        throw error;
      }
      await sleep(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)), deadline);
    }
  }
  throw lastError || zohoError('ZOHO_RETRY_EXHAUSTED', null);
}

async function handler(req, res) {
  const requestStart = nowMs();
  const deadline = Date.now() + ENDPOINT_TIMEOUT_MS;
  const requestId = crypto.randomUUID();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' });
  }
  const contentType = safeString(req.headers['content-type'], 100).toLowerCase();
  if (!contentType.startsWith(JSON_TYPE)) return reply(res, 415, { success: false, error: 'UNSUPPORTED_CONTENT_TYPE' });
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return reply(res, 413, { success: false, error: 'PAYLOAD_TOO_LARGE' });
  let body;
  try { body = parseBody(req); } catch { return reply(res, 400, { success: false, error: 'INVALID_JSON' }); }
  const validated = validate(body);
  if (validated.error) return reply(res, validated.error === 'SPAM_REJECTED' ? 400 : 422, { success: false, error: validated.error });

  const context = { requestId, submissionId: validated.lead.submissionId, phone: validated.lead.phone };
  try {
    const outcome = await submitLead(validated.lead, deadline, context);
    logEvent('info', 'lead_submission_success', context, {
      attempt: null, operation: outcome.idempotentReplay ? 'idempotent-existing' : 'create',
      zohoStatus: outcome.status, zohoLeadId: outcome.leadId,
      created: outcome.created, idempotentReplay: outcome.idempotentReplay,
      durationMs: Math.round(nowMs() - requestStart), failureReason: null,
    });
    return reply(res, 200, { success: true, requestId });
  } catch (error) {
    const code = error.message?.startsWith('MISSING_') ? 'SERVER_CONFIGURATION_ERROR'
      : error.message === 'ZOHO_AUTH_EXPIRED' || error.message === 'ZOHO_AUTH_FAILED' ? 'CRM_AUTH_UNAVAILABLE'
        : 'CRM_UNAVAILABLE';
    logEvent('error', 'lead_submission_failed', context, {
      attempt: null, operation: 'create', zohoStatus: error.zohoStatus || null,
      zohoLeadId: null, created: false, idempotentReplay: false,
      durationMs: Math.round(nowMs() - requestStart), failureReason: sanitizedFailure(error),
    });
    return reply(res, 503, { success: false, error: code, requestId });
  }
}

module.exports = handler;
module.exports._test = {
  normalizeIndianPhone, validate, crmRecord, transientStatus, submitLead, sanitizedFailure,
  resetToken() {
    localTokenCache = null;
    tokenRefreshPromise = null;
    globalThis.__vishanZohoToken = null;
    globalThis.__vishanZohoTokenRefresh = null;
  },
};
