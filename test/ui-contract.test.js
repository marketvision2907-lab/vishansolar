const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('renders the immediate secure submission state on the form', () => {
  assert.match(html, /form\.setAttribute\('aria-busy','true'\)/);
  assert.match(html, /Submitting your request\.\.\./);
  assert.match(html, /Please wait while we securely submit your details\./);
  assert.match(html, /if\(form\.dataset\.submitting==='true'\)return/);
});

test('keeps analytics events scoped and single-fire guarded', () => {
  assert.equal((html.match(/event:'generate_lead'/g) || []).length, 1);
  assert.equal((html.match(/event:'whatsapp_click'/g) || []).length, 1);
  assert.match(html, /if\(!whatsappTracked\)/);
  assert.doesNotMatch(html, /dataLayer\.push\([^)]*(fullName|phone|location)/);
});

test('success modal has the required content and pausable countdown', () => {
  assert.match(html, /Consultation Request Submitted/);
  assert.match(html, /Chat on WhatsApp/);
  assert.match(html, /Closing automatically in /);
  assert.match(html, /resultCard\.addEventListener\('pointerenter'/);
  assert.match(html, /resultCard\.addEventListener\('focusin'/);
  assert.match(html, /document\.hidden/);
  assert.match(html, /window\.addEventListener\('pagehide',cancelResultTimer\)/);
  assert.match(html, /lastResultFocus=form&&form\.querySelector\('button\[type="submit"\]'\)/);
});

test('the true LCP image is eager, responsive, and high priority', () => {
  assert.match(html, /hero-768\.webp 768w, assets\/hero-1600\.webp 1600w/);
  assert.match(html, /<picture class="hero-bg"/);
  assert.match(html, /fetchpriority="high"/);
  assert.doesNotMatch(html, /\.hero-bg\{[^}]*background-image/);
});

test('keeps one CRM form and the existing lead payload contract', () => {
  assert.equal((html.match(/<form\b/g) || []).length, 1);
  assert.match(html, /fetch\('\/api\/leads'/);
  for (const key of ['fullName', 'phone', 'billRange', 'location', 'companyWebsite', 'idempotencyKey', 'attribution']) {
    assert.match(html, new RegExp(`${key}:`));
  }
  assert.doesNotMatch(html, /Monthly Amount|Two-Month Bill Amount|billingPeriod/);
});

test('primary CTAs activate the embedded form without a popup form', () => {
  assert.match(html, /function activateForm/);
  assert.match(html, /quote\.classList\.add\('form-highlight'\)/);
  assert.match(html, /firstName\)\.focus/);
  assert.doesNotMatch(html, /id="ctaModal"|id="leadFormModal"/);
});

test('SEO and accessibility contracts are present', () => {
  assert.match(html, /Rooftop Solar Installation in Chennai \| Vishan Solar/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /aria-expanded="false" aria-controls=/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /event\.key==='Escape'.*closeNavigation\(true\)/);
  assert.match(html, /\.burger:focus-visible,\.faq-q:focus-visible/);
});
test('keeps the testimonial scaffold hidden until genuine media is approved', () => {
  assert.match(html, /id="testimonials"[^>]*hidden/);
  assert.match(html, /id="testiTrack"/);
  assert.match(html, /Keep this empty until genuine assets are approved/);
  assert.doesNotMatch(html, /Ramesh K\.|Lakshmi R\.|Suresh B\.|Karthik M\./);
});

test('accepts country-code autofill and retries transient API failures', () => {
  assert.doesNotMatch(html, /id="phone"[^>]*maxlength=/);
  assert.match(html, /function normalizeIndianPhone/);
  assert.match(html, /return '\+91'\+digits/);
  assert.match(html, /var retryableStatus=\{500:true,502:true,503:true,504:true\}/);
  assert.doesNotMatch(html, /retryableStatus=\{[^}]*429:true/);
  assert.match(html, /for\(var attempt=0;attempt<3;attempt\+\+\)/);
  assert.match(html, /idempotencyKey:idempotencyKey/);
});

test('implements the approved final hero and financing composition', () => {
  assert.match(html, /grid-template-columns:minmax\(0,1\.35fr\) minmax\(360px,1fr\)/);
  assert.match(html, /\.hero-content\{grid-column:1;text-align:left/);
  assert.match(html, /\.lead-form\{grid-column:2;justify-self:stretch/);
  assert.equal((html.match(/class="trust-card"/g) || []).length, 4);
  assert.match(html, /class="trust-card"><svg class="ic" aria-hidden="true"/);
  assert.doesNotMatch(html, /bank-grid|bank-badge|HDFC|Bajaj Finserv|Ecofy|Credit Fair/);
  assert.match(html, /grid-column:1;width:100%;max-width:520px;margin:0 auto 28px/);
  assert.match(html, /map-bg\.map-loaded\{background-image:url\('assets\/map\.webp'\)\}/);
  assert.match(html, /mapObserver\.observe\(map\)/);
});

test('publishes the approved business contact number everywhere', () => {
  assert.match(html, /> \+91 6385547200<\/a>/);
  assert.match(html, /href="tel:\+916385547200"/);
  assert.match(html, /https:\/\/wa\.me\/916385547200/);
  assert.match(html, /"telephone":"\+916385547200"/);
  assert.doesNotMatch(html, /9677127788|919677127788/);
});

test('declares a complete favicon package and valid web manifest', () => {
  const root = path.join(__dirname, '..');
  for (const file of [
    'favicon.ico',
    'favicon-16x16.png',
    'favicon-32x32.png',
    'apple-touch-icon.png',
    'android-chrome-192x192.png',
    'android-chrome-512x512.png',
    'site.webmanifest',
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} should exist`);
  }
  assert.match(html, /href="\/favicon\.ico"/);
  assert.match(html, /href="\/favicon-16x16\.png"/);
  assert.match(html, /href="\/favicon-32x32\.png"/);
  assert.match(html, /href="\/apple-touch-icon\.png"/);
  assert.match(html, /href="\/site\.webmanifest"/);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'site.webmanifest'), 'utf8'));
  assert.equal(manifest.theme_color, '#13306E');
  assert.deepEqual(manifest.icons.map(({ sizes, type }) => ({ sizes, type })), [
    { sizes: '192x192', type: 'image/png' },
    { sizes: '512x512', type: 'image/png' },
  ]);
});

test('preserves the public CRM form and phone-input contract', () => {
  assert.equal((html.match(/<form\b/g) || []).length, 1);
  assert.match(html, /id="leadForm" class="crm-lead-form"/);
  for (const name of ['companyWebsite', 'fullName', 'phone', 'billRange', 'location']) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /fetch\('\/api\/leads'/);
  assert.match(html, /idempotencyKey:idempotencyKey/);
  assert.doesNotMatch(html, /id="phone"[^>]*maxlength=/);
});
