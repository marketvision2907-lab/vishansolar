const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const FIELD_CACHE_TTL_MS = 60 * 60 * 1000;
const ALLOWED_BILL_RANGES = new Set([
  'Below ₹2,000',
  '₹2,000 – ₹5,000',
  '₹5,000 – ₹10,000',
  '₹10,000 – ₹20,000',
  'Above ₹20,000',
]);

const rateLimits = new Map();
let fieldMetadataCache = null;

function sendJson(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.json(body);
}

function customerError(res, status = 500) {
  return sendJson(res, status, {
    ok: false,
    message: "We couldn't submit your consultation request at the moment. Please try again in a few minutes.",
  });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const current = rateLimits.get(ip);
  if (!current || now >= current.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT_MAX_REQUESTS;
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validateInput(body) {
  const fullName = cleanText(body.full_name, 100);
  const phone = cleanText(body.phone, 20).replace(/\s+/g, '');
  const billRange = cleanText(body.bill_range, 50);
  const city = cleanText(body.location, 100);
  const honeypot = cleanText(body.website, 200);

  if (honeypot) return { error: 'spam' };
  if (fullName.length < 2 || !/^[6-9]\d{9}$/.test(phone) || !ALLOWED_BILL_RANGES.has(billRange)) {
    return { error: 'validation' };
  }

  return { fullName, phone, billRange, city };
}

function requiredEnvironment() {
  const names = [
    'ZOHO_CLIENT_ID',
    'ZOHO_CLIENT_SECRET',
    'ZOHO_REFRESH_TOKEN',
    'ZOHO_ACCOUNTS_URL',
    'ZOHO_API_DOMAIN',
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error('ZOHO_CONFIGURATION_MISSING');
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

async function zohoRequest(url, options, accessToken) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('ZOHO_REQUEST_FAILED');
    error.status = response.status;
    error.code = data?.code || data?.data?.[0]?.code || 'UNKNOWN';
    throw error;
  }
  return data;
}

async function getAccessToken(env) {
  const tokenUrl = `${env.ZOHO_ACCOUNTS_URL.replace(/\/+$/, '')}/oauth/v2/token`;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: env.ZOHO_REFRESH_TOKEN,
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error('ZOHO_AUTH_FAILED');
  return data.access_token;
}

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function getLeadFieldMetadata(apiDomain, accessToken) {
  const now = Date.now();
  if (fieldMetadataCache && fieldMetadataCache.expiresAt > now) return fieldMetadataCache.value;

  const metadata = await zohoRequest(
    `${apiDomain}/crm/v8/settings/fields?module=Leads&type=all`,
    { method: 'GET' },
    accessToken,
  );
  const fields = Array.isArray(metadata.fields) ? metadata.fields : [];
  const billField = fields.find((field) =>
    ['display_label', 'field_label'].some(
      (key) => normalizeLabel(field[key]) === 'monthly eb bill range',
    ),
  );
  if (!billField?.api_name) throw new Error('ZOHO_BILL_FIELD_NOT_FOUND');

  const phoneField = fields.find((field) => field.api_name === 'Phone');
  const value = {
    billFieldApiName: billField.api_name,
    phoneSupportsDuplicateCheck: Boolean(phoneField?.unique),
  };
  fieldMetadataCache = { value, expiresAt: now + FIELD_CACHE_TTL_MS };
  return value;
}

function leadPayload(input, billFieldApiName) {
  return {
    Last_Name: input.fullName,
    Phone: input.phone,
    [billFieldApiName]: input.billRange,
    ...(input.city ? { City: input.city } : {}),
    Lead_Source: 'Website',
    Description: 'Submitted from Vishan Solar website',
  };
}

function assertZohoSuccess(result) {
  const item = result?.data?.[0];
  if (!item || item.status !== 'success') {
    const error = new Error('ZOHO_RECORD_FAILED');
    error.code = item?.code || 'UNKNOWN';
    throw error;
  }
  return item;
}

async function upsertByUniquePhone(apiDomain, accessToken, lead) {
  const result = await zohoRequest(
    `${apiDomain}/crm/v8/Leads/upsert`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [lead], duplicate_check_fields: ['Phone'] }),
    },
    accessToken,
  );
  return assertZohoSuccess(result);
}

async function searchLeadByPhone(apiDomain, accessToken, phone) {
  const url = `${apiDomain}/crm/v8/Leads/search?phone=${encodeURIComponent(phone)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json' },
  });
  if (response.status === 204 || response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('ZOHO_SEARCH_FAILED');
  return data?.data?.[0]?.id || null;
}

async function createOrUpdateLead(apiDomain, accessToken, lead, phoneSupportsDuplicateCheck) {
  if (phoneSupportsDuplicateCheck) return upsertByUniquePhone(apiDomain, accessToken, lead);

  const existingId = await searchLeadByPhone(apiDomain, accessToken, lead.Phone);
  const url = existingId
    ? `${apiDomain}/crm/v8/Leads/${encodeURIComponent(existingId)}`
    : `${apiDomain}/crm/v8/Leads`;
  const result = await zohoRequest(
    url,
    {
      method: existingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [lead] }),
    },
    accessToken,
  );
  return assertZohoSuccess(result);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return customerError(res, 405);
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) return customerError(res, 429);

  const input = validateInput(req.body || {});
  if (input.error) return customerError(res, 400);

  try {
    const env = requiredEnvironment();
    const apiDomain = env.ZOHO_API_DOMAIN.replace(/\/+$/, '');
    const accessToken = await getAccessToken(env);
    const fields = await getLeadFieldMetadata(apiDomain, accessToken);
    const lead = leadPayload(input, fields.billFieldApiName);
    await createOrUpdateLead(apiDomain, accessToken, lead, fields.phoneSupportsDuplicateCheck);
    return sendJson(res, 200, { ok: true, message: 'Consultation request submitted.' });
  } catch (error) {
    console.error('Lead submission failed', {
      type: error?.message || 'UNKNOWN',
      status: error?.status || null,
      code: error?.code || null,
    });
    return customerError(res);
  }
};
