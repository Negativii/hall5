import { browserPath } from './browser-path.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:3100';
const out = path.resolve(process.env.PERFORMANCE_REPORT || 'tests/tmp/performance.json');
fs.mkdirSync(path.dirname(out), {recursive:true});
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
});
const report = {
  date: new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow'}).format(new Date()),
  kind: 'brief local production benchmark',
  environment: {
    browser: await browser.version(),
    hostPlatform: `${process.platform}/${process.arch}`,
    headless: true,
    origin: 'localhost',
    note: 'All scenarios run sequentially on the same Mac. Mobile viewport and CPU throttling are emulation, not an actual phone. WebGL measurements count submitted render frames, not display presentation.',
  },
  interpretation: {
    webglFrames: 'Counts WebGL clear/render submissions, not the number of frames physically presented by the screen.',
    videoDroppedFrames: 'Reported HTMLVideoElement frames dropped before decode or after missing a display deadline. Cause is not isolated here; hidden video texture sources do not justify ignoring these counters.',
    videoQualitySpecification: 'https://w3c.github.io/media-playback-quality/',
    mainThreadTime: 'CDP TaskDuration measures main-thread tasks; percentage is not total browser CPU or GPU utilization.',
    limitations: 'Brief demo on localhost, one Mac, headless Chrome, no real iPhone/Android or slow-internet test. CPU throttling does not emulate weaker GPU/video hardware.',
  },
  scenarios: [],
};

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 100) / 100;
}
function round(value) { return Math.round(value * 100) / 100; }

async function scenario({name, width, height, dpr, cpu = 1, seconds = 8}) {
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: dpr, locale: 'ru-RU'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {if (m.type() === 'error') errors.push(m.text());});
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Performance.enable');
  if (cpu !== 1) await session.send('Emulation.setCPUThrottlingRate', {rate: cpu});
  const transfers = new Map();
  session.on('Network.dataReceived', e => {
    const current = transfers.get(e.requestId) || {chunks:0,complete:0};
    current.chunks += e.encodedDataLength || 0;
    transfers.set(e.requestId,current);
  });
  session.on('Network.loadingFinished', e => {
    const current = transfers.get(e.requestId) || {chunks:0,complete:0};
    current.complete = e.encodedDataLength;
    transfers.set(e.requestId,current);
  });
  // Test-only instrumentation in this disposable browser context. Application
  // source and the user's open browser tabs are not modified.
  await page.addInitScript(() => {
    const metrics = {renders: [], draws: [], raf: [], longTasks: [], waits: [], states: []};
    Object.defineProperty(window, '__hall5PerformanceTest', {value: metrics});
    for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)) {
      for (const name of ['clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        if (!Object.prototype.hasOwnProperty.call(proto, name) || typeof proto[name] !== 'function') continue;
        const original = proto[name];
        proto[name] = function (...args) {
          if (this.canvas?.closest('.room3d')) {
            if (name === 'clear') metrics.renders.push(performance.now());
            else metrics.draws.push({at: performance.now(), instanced: name.endsWith('Instanced')});
          }
          return Reflect.apply(original, this, args);
        };
      }
    }
    const raf = at => {metrics.raf.push(at); requestAnimationFrame(raf);};
    requestAnimationFrame(raf);
    try {new PerformanceObserver(list => list.getEntries().forEach(e => metrics.longTasks.push({at:e.startTime, duration:e.duration}))).observe({entryTypes:['longtask']});} catch {}
    document.addEventListener('waiting', e => {if (e.target instanceof HTMLVideoElement) metrics.waits.push({at:performance.now(), surface:e.target.dataset.surface});}, true);
    let lastState;
    new MutationObserver(() => {
      const state = document.querySelector('.player')?.dataset.playbackState;
      if (state && state !== lastState) {metrics.states.push({at:performance.now(), state}); lastState = state;}
    }).observe(document, {subtree:true, attributes:true, attributeFilter:['data-playback-state'], childList:true});
  });
  const loadStart = performance.now();
  await page.goto(base + '/s/demo', {waitUntil:'networkidle'});
  await page.locator('.curtain__play').click();
  await page.locator('.room3d canvas').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].length === 5 && [...document.querySelectorAll('.video-pool video')].every(v => v.readyState >= 3));
  const readyMs = performance.now() - loadStart;
  await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing');
  await page.getByRole('button', {name:'Общий вид', exact:true}).click();
  await page.waitForTimeout(1700);
  const snapshot = () => page.evaluate(() => {
    const canvas = document.querySelector('.room3d canvas');
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      now: performance.now(),
      gpu: gl ? {vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)} : null,
      drawingBuffer: canvas ? {width:canvas.width, height:canvas.height} : null,
      videos: [...document.querySelectorAll('.video-pool video')].map(v => {
        const q = v.getVideoPlaybackQuality();
        return {surface:v.dataset.surface,width:v.videoWidth,height:v.videoHeight,time:v.currentTime,paused:v.paused,total:q.totalVideoFrames,dropped:q.droppedVideoFrames};
      }),
    };
  });
  const before = await snapshot();
  const cpuBefore = await session.send('Performance.getMetrics');
  await page.waitForTimeout(seconds * 1000);
  const after = await snapshot();
  const cpuAfter = await session.send('Performance.getMetrics');
  const records = await page.evaluate(({start,end}) => {
    const m = window.__hall5PerformanceTest;
    const between = e => e.at >= start && e.at < end;
    return {
      renders:m.renders.filter(at => at >= start && at < end),
      raf:m.raf.filter(at => at >= start && at < end),
      draws:m.draws.filter(between), longTasks:m.longTasks.filter(between), waits:m.waits.filter(between), states:m.states.filter(between),
    };
  }, {start:before.now,end:after.now});
  const elapsed = (after.now - before.now) / 1000;
  const intervals = values => values.slice(1).map((value,index) => value - values[index]);
  const cpuMetric = (list,name) => list.metrics.find(m => m.name === name)?.value || 0;
  const taskDelta = cpuMetric(cpuAfter,'TaskDuration') - cpuMetric(cpuBefore,'TaskDuration');
  const videoDeltas = after.videos.map((video,index) => {
    const prior = before.videos[index];
    const total = video.total - prior.total;
    const dropped = video.dropped - prior.dropped;
    return {surface:video.surface,width:video.width,height:video.height,totalFrames:total,droppedFrames:dropped,droppedPercent:total ? round(dropped/total*100) : 0,mediaTimeAdvancedSeconds:round(video.time - prior.time)};
  });
  await page.locator('.playbtn').click();
  await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'paused');
  await page.waitForTimeout(400);
  const pauseStart = await page.evaluate(() => performance.now());
  await page.waitForTimeout(1500);
  const pauseEnd = await page.evaluate(() => performance.now());
  const pauseFrames = await page.evaluate(({start,end}) => window.__hall5PerformanceTest.renders.filter(at=>at>=start&&at<end).length,{start:pauseStart,end:pauseEnd});
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const result = {
    name, viewport:{width,height,dpr}, cpuThrottleRate:cpu, gpu:before.gpu, drawingBuffer:before.drawingBuffer,
    readyMilliseconds:round(readyMs), elapsedSeconds:round(elapsed),
    webglSubmittedFrames:records.renders.length, webglSubmittedFramesPerSecond:round(records.renders.length/elapsed),
    webglIntervalP50Ms:percentile(intervals(records.renders),.5), webglIntervalP95Ms:percentile(intervals(records.renders),.95),
    rafCallbacksPerSecond:round(records.raf.length/elapsed),
    drawCallsPerSubmittedFrame:records.renders.length ? round(records.draws.length/records.renders.length) : null,
    instancedCalls:records.draws.filter(d=>d.instanced).length,
    longTasks:records.longTasks.length, longTaskTotalMilliseconds:round(records.longTasks.reduce((sum,t)=>sum+t.duration,0)),
    mainThreadTaskSeconds:round(taskDelta), mainThreadTaskPercentOfWallTime:round(taskDelta/elapsed*100),
    waitingEvents:records.waits, playbackStateChanges:records.states,
    networkBytesDuringLoadAndTest:[...transfers.values()].reduce((sum,item)=>sum+Math.max(item.chunks,item.complete),0), video:videoDeltas,
    paused:{seconds:round((pauseEnd-pauseStart)/1000),webglSubmittedFrames:pauseFrames},
    errors,
  };
  console.log(JSON.stringify({name,framesPerSecond:result.webglSubmittedFramesPerSecond,videoDroppedFrames:videoDeltas.map(v=>v.droppedFrames),longTasks:result.longTasks,pausedFrames:pauseFrames,gpu:result.gpu}));
  await context.close();
  return result;
}

try {
  report.scenarios.push(await scenario({name:'desktop',width:1440,height:900,dpr:1}));
  report.scenarios.push(await scenario({name:'mobile-size-on-this-Mac',width:390,height:844,dpr:2}));
  report.scenarios.push(await scenario({name:'desktop-4x-CPU-emulation',width:1440,height:900,dpr:1,cpu:4,seconds:6}));
  fs.writeFileSync(out,JSON.stringify(report,null,2));
  console.log(`Saved ${out}`);
} finally {await browser.close();}
