const crypto = require('node:crypto');

const JSON_TYPE = 'application/json';
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;
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

const rateBuckets = globalThis.__vishanRateBuckets || new Map();
const idempotencyCache = globalThis.__vishanIdempotencyCache || new Map();
globalThis.__vishanRateBuckets = rateBuckets;
globalThis.__vishanIdempotencyCache = idempotencyCache;

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

function safeUrl(value) {
  const text = safeString(value, 2048);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && Buffer.byteLength(req.body) <= MAX_BODY_BYTES) {
    return JSON.parse(req.body);
  }
  throw new Error('INVALID_BODY');
}

function validate(body) {
  const lead = {
    fullName: safeString(body.fullName, 80),
    phone: safeString(body.phone, 20).replace(/[\s()-]/g, '').replace(/^(\+91|91)/, ''),
    billRange: safeString(body.billRange, 80),
    location: safeString(body.location, 255),
    honeypot: safeString(body.companyWebsite, 200),
    idempotencyKey: safeString(body.idempotencyKey, 80),
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
  if (!/^[6-9]\d{9}$/.test(lead.phone)) return { error: 'INVALID_PHONE' };
  if (!ALLOWED_BILL_RANGES.has(lead.billRange)) return { error: 'INVALID_BILL_RANGE' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lead.idempotencyKey)) {
    return { error: 'INVALID_IDEMPOTENCY_KEY' };
  }
  return { lead };
}

function clientFingerprint(req) {
  const forwarded = safeString(req.headers['x-forwarded-for'], 256).split(',')[0].trim();
  const ip = forwarded || safeString(req.headers['x-real-ip'], 64) || 'unavailable';
  const agent = safeString(req.headers['user-agent'], 256);
  return crypto.createHash('sha256').update(`${ip}|${agent}`).digest('hex');
}

function isRateLimited(fingerprint, now) {
  const bucket = (rateBuckets.get(fingerprint) || []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  bucket.push(now);
  rateBuckets.set(fingerprint, bucket);
  return bucket.length > RATE_LIMIT_MAX;
}

function prune(now) {
  for (const [key, entry] of idempotencyCache) {
    if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) idempotencyCache.delete(key);
  }
  for (const [key, times] of rateBuckets) {
    const active = times.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
    if (active.length) rateBuckets.set(key, active);
    else rateBuckets.delete(key);
  }
}

function requiredEnv() {
  const names = [
    'ZOHO_CLIENT_ID',
    'ZOHO_CLIENT_SECRET',
    'ZOHO_REFRESH_TOKEN',
    'ZOHO_ACCOUNTS_URL',
    'ZOHO_API_DOMAIN',
  ];
  const values = {};
  for (const name of names) {
    if (!process.env[name]) throw new Error(`MISSING_${name}`);
    values[name] = process.env[name].replace(/\/+$/, '');
  }
  return values;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(env) {
  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const response = await fetchWithTimeout(
    `${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    },
    8000,
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== 'string') throw new Error('ZOHO_AUTH_FAILED');
  return data.access_token;
}

async function zohoRequest(env, token, path, options = {}) {
  return fetchWithTimeout(
    `${env.ZOHO_API_DOMAIN}/crm/v8${path}`,
    {
      ...options,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': JSON_TYPE,
        ...(options.headers || {}),
      },
    },
    10000,
  );
}

function crmRecord(lead) {
  const record = {
    [FIELD.lastName]: lead.fullName,
    [FIELD.phone]: lead.phone,
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

async function findExistingLead(env, token, phone) {
  const criteria = encodeURIComponent(`(${FIELD.phone}:equals:${phone})`);
  const response = await zohoRequest(env, token, `/Leads/search?criteria=${criteria}&fields=id&per_page=1`, {
    method: 'GET',
  });
  if (response.status === 204) return false;
  if (!response.ok) throw new Error(response.status === 401 ? 'ZOHO_AUTH_EXPIRED' : 'ZOHO_LOOKUP_FAILED');
  const data = await response.json().catch(() => ({}));
  return Boolean(data.data?.[0]?.id);
}

async function createLead(env, token, lead) {
  const response = await zohoRequest(env, token, '/Leads', {
    method: 'POST',
    body: JSON.stringify({
      data: [crmRecord(lead)],
      trigger: ['workflow'],
    }),
  });
  const data = await response.json().catch(() => ({}));
  const result = data.data?.[0];
  if (response.ok && result?.status === 'success' && result?.details?.id) return true;
  if (result?.code === 'DUPLICATE_DATA') return true;
  throw new Error(response.status === 401 ? 'ZOHO_AUTH_EXPIRED' : 'ZOHO_CREATE_FAILED');
}

async function submitLead(lead) {
  const env = requiredEnv();
  const token = await getAccessToken(env);
  if (await findExistingLead(env, token, lead.phone)) return { duplicate: true };
  await createLead(env, token, lead);
  return { duplicate: false };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const contentType = safeString(req.headers['content-type'], 100).toLowerCase();
  if (!contentType.startsWith(JSON_TYPE)) {
    return reply(res, 415, { success: false, error: 'UNSUPPORTED_CONTENT_TYPE' });
  }

  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
    return reply(res, 413, { success: false, error: 'PAYLOAD_TOO_LARGE' });
  }

  let body;
  try {
    body = parseBody(req);
  } catch {
    return reply(res, 400, { success: false, error: 'INVALID_JSON' });
  }

  const validated = validate(body);
  if (validated.error) {
    const status = validated.error === 'SPAM_REJECTED' ? 400 : 422;
    return reply(res, status, { success: false, error: validated.error });
  }

  const now = Date.now();
  prune(now);
  const fingerprint = clientFingerprint(req);
  if (isRateLimited(fingerprint, now)) {
    return reply(res, 429, { success: false, error: 'RATE_LIMITED' });
  }

  const cacheKey = crypto.createHash('sha256').update(validated.lead.idempotencyKey).digest('hex');
  const cached = idempotencyCache.get(cacheKey);
  if (cached?.result) return reply(res, cached.result.status, cached.result.payload);
  if (cached?.pending) return reply(res, 409, { success: false, error: 'SUBMISSION_IN_PROGRESS' });
  idempotencyCache.set(cacheKey, { createdAt: now, pending: true });

  try {
    const outcome = await submitLead(validated.lead);
    const result = { status: 200, payload: { success: true } };
    idempotencyCache.set(cacheKey, { createdAt: now, result });
    console.info('lead_submission_success', {
      requestId: cacheKey.slice(0, 12),
      duplicate: outcome.duplicate,
    });
    return reply(res, result.status, result.payload);
  } catch (error) {
    idempotencyCache.delete(cacheKey);
    const code =
      error?.name === 'AbortError'
        ? 'ZOHO_UNAVAILABLE'
        : error?.message === 'ZOHO_AUTH_EXPIRED' || error?.message === 'ZOHO_AUTH_FAILED'
          ? 'CRM_AUTH_UNAVAILABLE'
          : error?.message?.startsWith('MISSING_')
            ? 'SERVER_CONFIGURATION_ERROR'
            : 'CRM_UNAVAILABLE';
    console.error('lead_submission_failed', { requestId: cacheKey.slice(0, 12), code });
    return reply(res, 503, { success: false, error: code });
  }
};

module.exports._test = { validate, crmRecord, isRateLimited };
