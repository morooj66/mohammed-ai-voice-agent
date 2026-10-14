import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const result=await build({stdin:{contents:`import React from 'react'; import {renderToString} from 'react-dom/server'; import App from './src/App.jsx'; console.log(renderToString(React.createElement(App)));`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic'});
for(const mode of ['recorded','live']) {
  const prefix=`globalThis.window={location:{search:${JSON.stringify(`?mode=${mode}`)}}};\n`;
  const rendered=spawnSync(process.execPath,['-'],{input:prefix+result.outputFiles[0].text,encoding:'utf8',maxBuffer:5_000_000});
  if(rendered.status!==0)throw Error(`Render failed (${mode}): ${rendered.stderr}`);
  for(const label of ['تحدث مع محمد','شاهد المحاكاة','هذا مشروع تجريبي مستقل، ولا يتبع نجم أو أي شركة تأمين.'])assert.ok(rendered.stdout.includes(label),`${mode}: ${label}`);
  if(mode!=='live')assert.ok(rendered.stdout.includes('participant--khalid'));
  if(mode==='recorded')assert.ok(rendered.stdout.includes('محاكاة صوتية مكتوبة')&&rendered.stdout.includes('ليست مكالمة مباشرة'),'recorded: approved scripted simulation is labelled');
  console.log(`PASS: ${mode} renders required labels/disclosure (SSR only, not a visual browser test).`);
}
