// «شاهد المحاكاة» must only open PRERECORDED playback and never trigger a paid API operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { resolveMode } from '../src/lib/modes.js';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the «شاهد المحاكاة» link and every legacy simulation link resolve to prerecorded playback', () => {
  const ui = src('src/components/VoiceUI.jsx');
  assert.match(ui, /<a href="\?mode=recorded"[^>]*>شاهد المحاكاة<\/a>/);
  assert.doesNotMatch(ui, /href="\?mode=(ai|sim|generate)"/);          // no public link to live generation or the old script
  assert.doesNotMatch(ui, /معاينة بلا تكلفة/);
  for (const m of ['?mode=recorded', '?mode=ai', '?mode=sim']) assert.equal(resolveMode(m), 'recorded', m);
  assert.equal(resolveMode(''), 'recorded');                         // public landing page: no access code
  assert.equal(resolveMode('?mode=live'), 'live');                  // protected live page only on explicit choice
  assert.equal(resolveMode('?mode=unknown'), 'recorded');
  assert.equal(resolveMode('?mode=generate'), 'generate');            // internal only, access code required
});

test('the playback path contains no API, WebSocket or paid-service call', () => {
  for (const f of ['src/components/RecordedPlayer.jsx', 'src/hooks/useRecordedDemo.js', 'src/lib/recording-fixture.js']) {
    const code = src(f);
    for (const re of [/\/api\//, /fetch\(/, /WebSocket/, /elevenlabs/i, /getUserMedia/]) assert.doesNotMatch(code, re, `${f}: ${re}`);
  }
});

test('rendering «شاهد المحاكاة» makes zero network requests and shows the approved scripted simulation, labelled as such', async () => {
  const bundle = await build({ stdin: { contents: "import React from 'react'; import {renderToString} from 'react-dom/server'; import App from './src/App.jsx'; console.log(renderToString(React.createElement(App)));", resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic' });
  const spy = "globalThis.__calls=[];globalThis.fetch=(...a)=>{globalThis.__calls.push(String(a[0]));return new Promise(()=>{})};globalThis.WebSocket=function(u){globalThis.__calls.push('ws:'+u)};process.on('exit',()=>console.error('CALLS:'+JSON.stringify(globalThis.__calls)));";
  for (const mode of ['recorded', 'ai', 'sim']) {
    const r = spawnSync(process.execPath, ['-'], { input: `globalThis.window={location:{search:'?mode=${mode}'}};${spy}\n` + bundle.outputFiles[0].text, encoding: 'utf8', maxBuffer: 5_000_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /CALLS:\[\]/, `${mode}: unexpected request`);
    assert.ok(r.stdout.includes('محاكاة صوتية مكتوبة') && r.stdout.includes('ليست مكالمة مباشرة'), `${mode}: approved simulation + its disclosure`);
    assert.ok(r.stdout.includes('/recordings/scripted-khalid-mohammed-v3.m4a'), `${mode}: official v3 audio`);
    assert.ok(!r.stdout.includes('access-code'), `${mode}: no login form on the playback page`);
  }
});
