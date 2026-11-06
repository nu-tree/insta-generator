// 이미지 → 5초 영상 → 인스타 게시 파이프라인 (웹앱·나중에 텔레그램 봇이 함께 쓰는 핵심 로직)
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as hf from './higgsfield.mjs';
import * as ig from './instagram.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const OUTPUT_DIR = path.join(ROOT, 'outputs');
const LOG_FILE = path.join(ROOT, 'logs', 'jobs.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMock = () => process.env.MOCK === '1';

const jobs = new Map();

/** 작업 상태가 바뀔 때마다 'update'(job) 이벤트 — 텔레그램 봇·터미널 로그가 구독 */
export const events = new EventEmitter();
const emit = (job) => events.emit('update', job);

export const STEPS = [
  { key: 'upload', label: '이미지 업로드' },
  { key: 'generate', label: '5초 영상 생성' },
  { key: 'save', label: '영상 저장' },
  { key: 'instagram', label: '인스타그램 게시' },
];

function newJob({ prompt, caption, autoPublish, source }) {
  const job = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    prompt, caption, autoPublish,
    source: source || 'web', // web | telegram
    mock: isMock(),
    state: 'running', // running | ready | publishing | done | error | canceled
    step: 'upload',
    message: '시작',
    videoUrl: null, localVideo: null,
    result: null, error: null,
  };
  jobs.set(job.id, job);
  return job;
}

const set = (job, step, message) => { Object.assign(job, { step, message }); emit(job); };
const finish = (job, fields) => { Object.assign(job, fields); emit(job); };

async function log(job) {
  await mkdir(path.dirname(LOG_FILE), { recursive: true });
  const { id, createdAt, prompt, caption, state, videoUrl, localVideo, result, error, mock } = job;
  await appendFile(LOG_FILE, JSON.stringify({ id, createdAt, finishedAt: new Date().toISOString(), mock, prompt, caption, state, videoUrl, localVideo, result, error }) + '\n');
}

export function getJob(id) { return jobs.get(id); }

export function startJob({ image, contentType, prompt, caption, autoPublish, source }) {
  const job = newJob({ prompt, caption, autoPublish, source });
  // 다시 생성용으로 원본 이미지를 메모리에 보관 (로그·API 응답에는 포함되지 않음)
  job.input = { image, contentType };
  run(job, image, contentType).catch(async (e) => {
    finish(job, { state: 'error', error: e.message, message: e.message });
    console.error(`[${job.id}] ❌ ${e.message}`);
    await log(job).catch(() => {});
  });
  return job;
}

async function run(job, image, contentType) {
  // 1) 이미지 업로드
  set(job, 'upload', '이미지를 힉스필드에 올리는 중');
  let imageUrl;
  if (job.mock) { await sleep(800); imageUrl = 'mock://image'; }
  else imageUrl = await hf.uploadImage(image, contentType);

  // 2) 영상 생성
  set(job, 'generate', '영상 생성 요청 중');
  if (job.mock) {
    for (let t = 0; t <= 6; t += 2) { set(job, 'generate', `영상 생성 중 (연습 모드, ${t}초)`); await sleep(1000); }
    job.videoUrl = null;
  } else {
    const requestId = await hf.submitImageToVideo({ imageUrl, prompt: job.prompt, duration: 5 });
    console.log(`[${job.id}] 힉스필드 요청 ${requestId}`);
    job.videoUrl = await hf.waitForVideo(requestId, (status, sec) => {
      const ko = { queued: '대기열', in_progress: '생성 중', retrying: '재시도 중' }[status] || status;
      set(job, 'generate', `영상 ${ko} (${sec}초 경과 · 보통 1~5분)`);
    });
  }

  // 3) 영상 내려받아 보관 (힉스필드 URL은 일정 시간 후 만료됨)
  set(job, 'save', '영상 저장 중');
  if (!job.mock) {
    const res = await fetch(job.videoUrl);
    if (!res.ok) throw new Error(`영상 다운로드 실패 (${res.status})`);
    await mkdir(OUTPUT_DIR, { recursive: true });
    const file = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}_${job.id}.mp4`;
    await writeFile(path.join(OUTPUT_DIR, file), Buffer.from(await res.arrayBuffer()));
    job.localVideo = file;
  }

  if (!job.autoPublish) {
    finish(job, { state: 'ready', step: 'instagram', message: '영상 완성! 확인 후 [인스타에 게시] 를 누르세요.' });
    return;
  }
  await publish(job);
}

export async function publish(job) {
  if (!['ready', 'running'].includes(job.state)) throw new Error('게시할 수 없는 상태입니다: ' + job.state);
  finish(job, { state: 'publishing', step: 'instagram', message: '인스타그램 게시 준비', error: null });
  try {
    if (job.mock) {
      for (const m of ['인스타그램에 영상 전달 중', '인스타그램 처리 중 (IN_PROGRESS)', '게시하는 중']) { set(job, 'instagram', m + ' · 연습 모드'); await sleep(1000); }
      job.result = { mediaId: 'MOCK', permalink: null, username: '(연습 모드 · 실제 게시 안 됨)' };
    } else {
      job.result = await ig.publishReel({
        videoUrl: job.videoUrl,
        caption: job.caption,
        onStep: (_k, msg) => set(job, 'instagram', msg),
      });
    }
    finish(job, { state: 'done', step: 'done', message: '게시 완료!' });
    console.log(`[${job.id}] ✅ 게시 완료 ${job.result.permalink || ''}`);
    await log(job);
  } catch (e) {
    // 영상은 남아 있으니 다시 게시할 수 있게 ready 로 되돌린다
    finish(job, { state: job.videoUrl || job.mock ? 'ready' : 'error', error: e.message, message: e.message });
    console.error(`[${job.id}] ❌ ${e.message}`);
    await log(job).catch(() => {});
    throw e;
  }
}

/** 게시 전 영상을 버린다 (ready 상태에서만) */
export async function cancel(job) {
  if (job.state !== 'ready') throw new Error('취소할 수 없는 상태입니다: ' + job.state);
  finish(job, { state: 'canceled', message: '게시 안 함' });
  console.log(`[${job.id}] 🗑 취소됨`);
  await log(job).catch(() => {});
}

export async function checkSetup() {
  if (isMock()) {
    return { mock: true, higgsfield: { ok: true, note: '연습 모드' }, instagram: { ok: true, username: '연습 모드' } };
  }
  const out = { mock: false };
  out.higgsfield = await hf.checkCredentials().catch((e) => ({ ok: false, error: e.message }));
  try {
    ig.resetAccountCache();
    const a = await ig.getAccount();
    out.instagram = { ok: true, username: a.username, id: a.id };
  } catch (e) {
    out.instagram = { ok: false, error: e.message };
  }
  return out;
}
