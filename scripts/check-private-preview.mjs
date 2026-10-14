import { readdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
const files = await readdir('preview-dist', { recursive: true, withFileTypes: true });
let bytes = '';
for (const file of files.filter(f => f.isFile())) {
  assert.ok(/\.(html|js|css)$/.test(file.name) || file.name === 'vercel.json', `Unexpected deployment file: ${file.name}`);
  bytes += await readFile(`${file.parentPath}/${file.name}`, 'utf8');
}
for (const pattern of [/elevenlabs/i, /anthropic/i, /getUserMedia/, /WebSocket/, /\/api\/login/, /conversation-token/, /sk-[a-zA-Z0-9]{20}/, /BEGIN PRIVATE KEY/]) assert.ok(!pattern.test(bytes), `Forbidden live capability or secret: ${pattern}`);
const bundled = await build({stdin:{contents:"import React from 'react'; import {renderToString} from 'react-dom/server'; import App from './preview/App.jsx'; console.log(renderToString(React.createElement(App)));",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic'});
for (const mode of ['recorded', 'live', 'ai', 'sim', 'unknown']) {
 const result = spawnSync(process.execPath,['-'],{input:`globalThis.window={location:{search:'?mode=${mode}'}};\n`+bundled.outputFiles[0].text,encoding:'utf8'});
 assert.equal(result.status, 0, result.stderr);
 assert.ok(result.stdout.includes('التسجيل المعتمد قيد الإعداد'));   // built artifact never contains the unapproved draft
 assert.ok(!result.stdout.includes('access-code'));
 assert.ok(result.stdout.includes('participant--khalid'));
 console.log(`PASS static preview ${mode}: recorded playback only, pending state, no login (SSR).`);
}
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
await writeFile('preview-dist/vercel.json', JSON.stringify({$schema:'https://openapi.vercel.sh/vercel.json',framework:null,buildCommand:null,installCommand:null,headers:[{source:'/(.*)',headers:[{key:'Content-Security-Policy',value:csp},{key:'Permissions-Policy',value:'microphone=(), camera=(), geolocation=()'},{key:'X-Content-Type-Options',value:'nosniff'},{key:'X-Frame-Options',value:'DENY'},{key:'Referrer-Policy',value:'no-referrer'},{key:'X-Robots-Tag',value:'noindex, nofollow'}]}]},null,2)+'\n');
console.log('PASS static artifact: no live SDK/API, no microphone, restrictive CSP, no server functions. Account-level Vercel protection still must be verified before deployment.');
