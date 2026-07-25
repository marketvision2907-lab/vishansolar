const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../api/leads');

const valid = {
  fullName: '  Test Customer  ',
  phone: '+91 98765 43210',
  billRange: '₹5,000 – ₹10,000',
  location: ' Chennai ',
  companyWebsite: '',
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  attribution: {
    utm_source: ' facebook ',
    landing_page_url: 'https://www.vishansolar.com/?utm_source=facebook',
  },
};

test('normalises a valid lead without inventing attribution', () => {
  const result = _test.validate(valid);
  assert.equal(result.lead.fullName, 'Test Customer');
  assert.equal(result.lead.phone, '9876543210');
  assert.equal(result.lead.location, 'Chennai');
  assert.equal(result.lead.attribution.utmSource, 'facebook');
  assert.equal(result.lead.attribution.utmMedium, '');
});

test('rejects invalid Indian mobile numbers', () => {
  assert.equal(_test.validate({ ...valid, phone: '1234567890' }).error, 'INVALID_PHONE');
});

test('rejects the honeypot before CRM submission', () => {
  assert.equal(_test.validate({ ...valid, companyWebsite: 'https://spam.example' }).error, 'SPAM_REJECTED');
});

test('maps exact Zoho API field names and omits blank optional values', () => {
  const lead = _test.validate(valid).lead;
  const record = _test.crmRecord(lead);
  assert.deepEqual(record, {
    Last_Name: 'Test Customer',
    Phone: '9876543210',
    Monthly_EB_Bill_Range: '₹5,000 – ₹10,000',
    Lead_Source: 'Advertisement',
    Lead_Status: 'Not Contacted',
    City: 'Chennai',
    UTM_Source: 'facebook',
    Landing_Page_URL: 'https://www.vishansolar.com/?utm_source=facebook',
  });
});

function invoke(method, headers, body) {
  const handler = require('../api/leads');
  return new Promise((resolve) => {
    const response = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(value) { resolve({ status: this.statusCode, body: JSON.parse(value), headers: this.headers }); },
    };
    handler({ method, headers, body }, response);
  });
}

test('accepts only POST requests', async () => {
  const response = await invoke('GET', {}, null);
  assert.equal(response.status, 405);
  assert.deepEqual(response.body, { success: false, error: 'METHOD_NOT_ALLOWED' });
});

test('rejects non-JSON content types before Zoho', async () => {
  const response = await invoke('POST', { 'content-type': 'text/plain' }, valid);
  assert.equal(response.status, 415);
  assert.deepEqual(response.body, { success: false, error: 'UNSUPPORTED_CONTENT_TYPE' });
});

test('rejects invalid form data before Zoho', async () => {
  const response = await invoke('POST', { 'content-type': 'application/json' }, { ...valid, phone: '123' });
  assert.equal(response.status, 422);
  assert.deepEqual(response.body, { success: false, error: 'INVALID_PHONE' });
});
