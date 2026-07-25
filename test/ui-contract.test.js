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
