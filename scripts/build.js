const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
if (path.dirname(output) !== root || path.basename(output) !== 'public') {
  throw new Error('Refusing to build outside the project public directory');
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const item of [
  'index.html',
  'robots.txt',
  'sitemap.xml',
  'site.webmanifest',
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'apple-touch-icon.png',
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
  'assets',
]) {
  fs.cpSync(path.join(root, item), path.join(output, item), { recursive: true });
}

require('node:child_process').execFileSync(process.execPath, ['--check', path.join(root, 'api', 'leads.js')], {
  stdio: 'inherit',
});
console.log('Built static site in public/');
