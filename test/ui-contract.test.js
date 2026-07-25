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
});
test('keeps the testimonial scaffold hidden until genuine media is approved', () => {
  assert.match(html, /id="testimonials"[^>]*hidden/);
  assert.match(html, /id="testiTrack"/);
  assert.match(html, /Keep this empty until genuine assets are approved/);
  assert.doesNotMatch(html, /Ramesh K\.|Lakshmi R\.|Suresh B\.|Karthik M\./);
});

test('implements the approved final hero and financing composition', () => {
  assert.match(html, /grid-template-columns:minmax\(190px,26%\) minmax\(500px,46%\) minmax\(380px,28%\)/);
  assert.equal((html.match(/class="trust-card"/g) || []).length, 4);
  assert.match(html, /class="trust-card"><svg class="ic" aria-hidden="true"/);
  assert.doesNotMatch(html, /bank-grid|bank-badge|HDFC|Bajaj Finserv|Ecofy|Credit Fair/);
  assert.match(html, /width:calc\(100% - 12px\);max-width:430px;margin:0 0 28px auto/);
  assert.match(html, /map-bg\.map-loaded\{background-image:url\('assets\/map\.webp'\)\}/);
  assert.match(html, /mapObserver\.observe\(map\)/);
});
