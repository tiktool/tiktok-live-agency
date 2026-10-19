// Fails the build when the API key could reach the browser: a NEXT_PUBLIC_ copy of it, or its value inside a client bundle.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const exposedNames = Object.keys(process.env).filter((k) => k.startsWith('NEXT_PUBLIC_') && /TIKTOOLS|API_KEY/i.test(k));
if (exposedNames.length) {
  console.error(`check-bundle: remove ${exposedNames.join(', ')}. The tik.tools key must stay server-side (TIKTOOLS_API_KEY).`);
  process.exit(1);
}

const key = process.env.TIKTOOLS_API_KEY;
const dir = join('.next', 'static');
if (!key || !existsSync(dir)) {
  console.log('check-bundle: no key in this build environment or no client bundle; nothing to scan.');
  process.exit(0);
}

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const leaked = walk(dir).filter((f) => /\.(js|json|html|txt)$/.test(f) && readFileSync(f, 'utf8').includes(key));
if (leaked.length) {
  console.error(`check-bundle: the API key appears in client files:\n${leaked.join('\n')}`);
  process.exit(1);
}
console.log(`check-bundle: API key not found in ${dir}.`);
