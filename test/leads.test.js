const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('../api/leads');
const { _test } = handler;
const apiSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'leads.js'), 'utf8');

const valid = {
  fullName: 'TEST - Reliability Submission 1',
  phone: '+91 98765 43210',
  billRange: '₹5,000 – ₹10,000',
  location: 'Chennai',
  companyWebsite: '',
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  attribution: { utm_source: 'test' },
};
const env = {
  ZOHO_CLIENT_ID: 'client-id-secret',
  ZOHO_CLIENT_SECRET: 'client-secret-value',
  ZOHO_REFRESH_TOKEN: 'refresh-token-value',
  ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.test',
  ZOHO_API_DOMAIN: 'https://api.zoho.test',
};
const metaEnv = {
  META_PIXEL_ID: '1623722882692138',
  META_CONVERSIONS_API_ACCESS_TOKEN: 'meta-test-token-secret',
  META_GRAPH_API_VERSION: 'v25.0',
};

function response(status, body = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
function tokenResponse() {
  return response(200, { access_token: 'access-token-value', expires_in: 3600 });
}
function created(id = 'lead-1') {
  return response(201, { data: [{ status: 'success', details: { id } }] });
}
function duplicate(id = 'lead-1') {
  return response(400, { data: [{ status: 'error', code: 'DUPLICATE_DATA', details: { id } }] });
}
function verified(id, submissionId) {
  return response(200, { data: [{ id, Website_Submission_ID: submissionId }] });
}
async function withMock(fetchImpl, action, extraEnv = {}) {
  const oldFetch = global.fetch;
  const oldEnv = {};
  const activeEnv = { ...env, ...extraEnv };
  for (const [key, value] of Object.entries(activeEnv)) {
    oldEnv[key] = process.env[key];
    process.env[key] = value;
  }
  global.fetch = fetchImpl;
  _test.resetToken();
  try { return await action(); } finally {
    global.fetch = oldFetch;
    _test.resetToken();
    for (const key of Object.keys(activeEnv)) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
  }
}
function invoke(body = valid, headers = { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }) {
  return new Promise((resolve) => {
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(value) { resolve({ status: this.statusCode, body: JSON.parse(value), headers: this.headers }); },
    };
    handler({ method: 'POST', headers, body }, res);
  });
}

test('normalizes all requested Indian formats without truncation', () => {
  for (const input of ['6385547200', '+91 6385547200', '91 6385547200', '0916385547200', '+91-63855-47200']) {
    assert.equal(_test.normalizeIndianPhone(input), '+916385547200');
  }
});
test('rejects invalid phone and honeypot before Zoho', () => {
  assert.equal(_test.validate({ ...valid, phone: '123' }).error, 'INVALID_PHONE');
  assert.equal(_test.validate({ ...valid, phone: '+91 638554720012' }).error, 'INVALID_PHONE');
  assert.equal(_test.validate({ ...valid, companyWebsite: 'bot' }).error, 'SPAM_REJECTED');
});
test('maps the durable submission ID and exact Zoho fields', () => {
  const record = _test.crmRecord(_test.validate(valid).lead);
  assert.equal(record.Website_Submission_ID, valid.idempotencyKey);
  assert.equal(record.Mobile, '+919876543210');
  assert.equal(Object.hasOwn(record, 'Phone'), false);
  assert.equal(record.Last_Name, valid.fullName);
});
test('only Zoho transient statuses are retryable', () => {
  for (const status of [429, 500, 502, 503, 504]) assert.equal(_test.transientStatus(status), true);
  for (const status of [400, 401, 403, 422]) assert.equal(_test.transientStatus(status), false);
});
test('normal valid submission succeeds only after exact Zoho create confirmation', async () => {
  let calls = 0;
  await withMock(async (url) => {
    calls += 1;
    return url.includes('/oauth/') ? tokenResponse() : created('lead-normal');
  }, async () => {
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(calls, 2);
  });
});
test('same submission ID replay verifies the exact Zoho record', async () => {
  let crmCalls = 0;
  await withMock(async (url) => {
    if (url.includes('/oauth/')) return tokenResponse();
    crmCalls += 1;
    return crmCalls === 1 ? duplicate('lead-existing') : verified('lead-existing', valid.idempotencyKey);
  }, async () => {
    const result = await invoke();
    assert.equal(result.status, 200);
    assert.equal(crmCalls, 2);
  });
});
test('duplicate response with a mismatched submission ID never reports success', async () => {
  await withMock(async (url) => url.includes('/oauth/') ? tokenResponse() : (
    url.includes('/Leads/lead-existing') ? verified('lead-existing', crypto.randomUUID()) : duplicate('lead-existing')
  ), async () => {
    const result = await invoke();
    assert.equal(result.status, 503);
    assert.equal(result.body.success, false);
  });
});
test('concurrent same-ID requests atomically create once and both confirm success', async () => {
  let inserted = false;
  let creates = 0;
  await withMock(async (url) => {
    if (url.includes('/oauth/')) return tokenResponse();
    if (url.includes('/Leads/lead-concurrent')) return verified('lead-concurrent', valid.idempotencyKey);
    creates += 1;
    if (!inserted) { inserted = true; return created('lead-concurrent'); }
    return duplicate('lead-concurrent');
  }, async () => {
    const [a, b] = await Promise.all([invoke(), invoke()]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(creates, 2);
  });
});
test('different submission IDs using the same phone both create enquiries', async () => {
  let creates = 0;
  await withMock(async (url) => {
    if (url.includes('/oauth/')) return tokenResponse();
    creates += 1;
    return created(`lead-${creates}`);
  }, async () => {
    const second = { ...valid, idempotencyKey: '223e4567-e89b-42d3-a456-426614174001' };
    assert.equal((await invoke(valid)).status, 200);
    assert.equal((await invoke(second)).status, 200);
    assert.equal(creates, 2);
  });
});
test('restart and separate-instance replay remains durable in Zoho', async () => {
  for (let instance = 0; instance < 2; instance += 1) {
    await withMock(async (url) => {
      if (url.includes('/oauth/')) return tokenResponse();
      if (url.includes('/Leads/lead-durable')) return verified('lead-durable', valid.idempotencyKey);
      return duplicate('lead-durable');
    }, async () => assert.equal((await invoke()).status, 200));
  }
});
test('expired token refreshes and retries safely', async () => {
  let tokens = 0;
  let creates = 0;
  await withMock(async (url) => {
    if (url.includes('/oauth/')) { tokens += 1; return tokenResponse(); }
    creates += 1;
    return creates === 1 ? response(401, {}) : created('lead-refreshed');
  }, async () => assert.equal((await invoke()).status, 200));
  assert.equal(tokens, 2);
  assert.equal(creates, 2);
});

test('successful Zoho lead sends one CAPI Lead with matching event ID and normalized user data', async () => {
  const submissionId = valid.idempotencyKey;
  const eventId = `vishan_lead_${submissionId}`;
  let capiPayload;
  let capiCalls = 0;
  const body = {
    ...valid,
    meta: {
      eventId,
      fbp: 'fb.1.1700000000000.111111111',
      fbc: 'fb.1.1700000000000.test-fbclid',
      eventSourceUrl: 'https://www.vishansolar.com/?utm_source=meta',
    },
  };
  await withMock(async (url, options) => {
    if (url.includes('/oauth/')) return tokenResponse();
    if (url.includes('graph.facebook.com')) {
      capiCalls += 1;
      capiPayload = JSON.parse(options.body);
      return response(200, { events_received: 1 });
    }
    return created('lead-meta');
  }, async () => {
    const result = await invoke(body, {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      'user-agent': 'Vishan Meta Test Agent',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.eventId, eventId);
  }, metaEnv);
  assert.equal(capiCalls, 1);
  assert.equal(capiPayload.data[0].event_name, 'Lead');
  assert.equal(capiPayload.data[0].event_id, eventId);
  assert.equal(capiPayload.data[0].action_source, 'website');
  assert.equal(capiPayload.data[0].user_data.ph[0], _test.sha256('919876543210'));
  assert.equal(capiPayload.data[0].user_data.client_ip_address, '203.0.113.7');
  assert.equal(capiPayload.data[0].user_data.client_user_agent, 'Vishan Meta Test Agent');
  assert.equal(capiPayload.data[0].user_data.fbp, body.meta.fbp);
  assert.equal(capiPayload.data[0].user_data.fbc, body.meta.fbc);
  assert.doesNotMatch(JSON.stringify(capiPayload), /\+919876543210/);
});

test('Meta CAPI failure never changes a successful Zoho customer response', async () => {
  let capiCalls = 0;
  await withMock(async (url) => {
    if (url.includes('/oauth/')) return tokenResponse();
    if (url.includes('graph.facebook.com')) { capiCalls += 1; return response(500, {}); }
    return created('lead-capi-failure');
  }, async () => {
    const result = await invoke(valid);
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.eventId, `vishan_lead_${valid.idempotencyKey}`);
  }, metaEnv);
  assert.equal(capiCalls, 1);
});

test('Zoho failure prevents Meta CAPI Lead', async () => {
  let capiCalls = 0;
  await withMock(async (url) => {
    if (url.includes('/oauth/')) return tokenResponse();
    if (url.includes('graph.facebook.com')) { capiCalls += 1; return response(200, {}); }
    return response(400, { data: [{ code: 'INVALID_DATA' }] });
  }, async () => {
    const result = await invoke(valid);
    assert.equal(result.status, 503);
    assert.equal(result.body.success, false);
  }, metaEnv);
  assert.equal(capiCalls, 0);
});

test('optional Meta test event code is server-side and included only when configured', async () => {
  let capiPayload;
  await withMock(async (url, options) => {
    if (url.includes('/oauth/')) return tokenResponse();
    if (url.includes('graph.facebook.com')) {
      capiPayload = JSON.parse(options.body);
      return response(200, { events_received: 1 });
    }
    return created('lead-test-code');
  }, async () => assert.equal((await invoke(valid)).status, 200), {
    ...metaEnv,
    META_TEST_EVENT_CODE: 'TEST12345',
  });
  assert.equal(capiPayload.test_event_code, 'TEST12345');
});
for (const status of [429, 500, 502, 503, 504]) {
  test(`retries Zoho HTTP ${status} and succeeds on third attempt`, async () => {
    let creates = 0;
    await withMock(async (url) => {
      if (url.includes('/oauth/')) return tokenResponse();
      creates += 1;
      return creates < 3 ? response(status, {}) : created(`lead-${status}`);
    }, async () => assert.equal((await invoke()).status, 200));
    assert.equal(creates, 3);
  });
}
test('retries timeout/network failures and returns friendly failure after exhaustion', async () => {
  let creates = 0;
  await withMock(async (url) => {
    if (url.includes('/oauth/')) return tokenResponse();
    creates += 1;
    throw new TypeError('socket secret must not escape');
  }, async () => {
    const result = await invoke();
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'CRM_UNAVAILABLE');
  });
  assert.equal(creates, 3);
});
test('does not retry permanent Zoho validation errors', async () => {
  let creates = 0;
  await withMock(async (url) => {
    if (url.includes('/oauth/')) return tokenResponse();
    creates += 1;
    return response(400, { data: [{ code: 'INVALID_DATA' }] });
  }, async () => assert.equal((await invoke()).status, 503));
  assert.equal(creates, 1);
});
test('many legitimate users behind the same IP receive no local 429', async () => {
  let creates = 0;
  await withMock(async (url) => {
    if (url.includes('/oauth/')) return tokenResponse();
    creates += 1;
    return created(`lead-shared-${creates}`);
  }, async () => {
    const results = [];
    for (let i = 0; i < 8; i += 1) {
      results.push(await invoke({ ...valid, idempotencyKey: `123e4567-e89b-42d3-a456-4266141740${String(i).padStart(2, '0')}` }));
    }
    assert.deepEqual(results.map((item) => item.status), Array(8).fill(200));
  });
});
test('source has no IP limiter or phone dedup and logs no secret values', () => {
  assert.doesNotMatch(apiSource, /RATE_LIMIT|rateBuckets|clientFingerprint|findExistingLead/);
  assert.match(apiSource, /Website_Submission_ID/);
  assert.match(apiSource, /created: outcome\.created/);
  assert.match(apiSource, /idempotentReplay: outcome\.idempotentReplay/);
  assert.doesNotMatch(apiSource, /console\.(?:info|warn|error)\([^)]*(?:ZOHO_CLIENT_SECRET|ZOHO_REFRESH_TOKEN|access_token|Authorization)/s);
  assert.doesNotMatch(apiSource, /phone:\s*context\.phone/);
  assert.doesNotMatch(apiSource, /META_CONVERSIONS_API_ACCESS_TOKEN[^\n]*(?:console|reply)/);
  assert.equal(_test.sanitizedFailure(new TypeError('access-token-value')), 'NETWORK_FAILURE');
});
