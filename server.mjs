// 인스타 제너레이터 — 로컬 웹앱 서버 (외부 패키지 없음, Node 21.7+)
import http from 'node:http';
import { readFile, stat, copyFile, access, readdir, writeFile, mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const ENV = path.join(ROOT, '.env');

// .env 없으면 예시 파일로 만들어 준다
try { await access(ENV); } catch { await copyFile(path.join(ROOT, '.env.example'), ENV); }
process.loadEnvFile(ENV);
if (process.argv.includes('--mock')) process.env.MOCK = '1';

const { startJob, getJob, publish, cancel, checkSetup, events, OUTPUT_DIR } = await import('./lib/pipeline.mjs');
const { startTelegram } = await import('./lib/telegram.mjs');
const merge = await import('./lib/merge.mjs');

// ── 팀 영상 합치기 ──
// outputs/            내가 만든 5초 영상
// outputs/team-inbox  팀원에게 받은 클립 (업로드)
// outputs/team-merged 합친 결과
const DIRS = { mine: OUTPUT_DIR, inbox: path.join(OUTPUT_DIR, 'team-inbox'), merged: path.join(OUTPUT_DIR, 'team-merged') };
const MAX_CLIP = 200 * 1024 * 1024;
const mergeJobs = new Map();
const FILE_RE = /^[\w-]+(\.[\w-]+)*\.mp4$/; // 경로 문자(/ \ ..) 불가
const refPath = (ref) => {
  const m = String(ref).match(/^(mine|inbox):(.+)$/);
  if (!m || !FILE_RE.test(m[2])) throw new Error('잘못된 클립: ' + ref);
  return path.join(DIRS[m[1]], m[2]);
};
async function listMp4(dir) {
  const names = await readdir(dir).catch(() => []);
  const out = [];
  for (const n of names.filter((n) => FILE_RE.test(n))) {
    const st = await stat(path.join(dir, n)).catch(() => null);
    if (st?.isFile()) out.push({ file: n, size: st.size, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// 터미널에도 단계가 바뀔 때마다 진행 상황을 찍는다 (같은 단계의 초 단위 갱신은 생략)
const lastStep = new Map();
events.on('update', (job) => {
  const key = `${job.state}/${job.step}`;
  if (lastStep.get(job.id) === key || job.state === 'done' || job.state === 'error') return;
  lastStep.set(job.id, key);
  console.log(`[${job.id}] … ${job.message}`);
});

const PORT = Number(process.env.PORT) || 3000;
const MAX_IMAGE = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

function readBody(req, limit, tooBig = '이미지가 너무 큽니다 (최대 10MB).') {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error(tooBig)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const publicJob = (j) => j && ({
  id: j.id, state: j.state, step: j.step, message: j.message, mock: j.mock,
  video: j.localVideo ? `/outputs/${j.localVideo}` : null,
  result: j.result, error: j.error,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(path.join(ROOT, 'public', 'index.html')));
    }

    if (req.method === 'GET' && p === '/api/setup') return json(res, 200, await checkSetup());

    if (req.method === 'POST' && p === '/api/jobs') {
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
      if (!IMAGE_TYPES.includes(contentType)) return json(res, 400, { error: 'JPG, PNG, WEBP 이미지만 사용할 수 있습니다.' });
      const prompt = (url.searchParams.get('prompt') || '').trim();
      const caption = (url.searchParams.get('caption') || '').trim();
      if (!prompt) return json(res, 400, { error: '영상 프롬프트를 입력하세요.' });
      if (caption.length > 2200) return json(res, 400, { error: '캡션은 2200자 이하여야 합니다.' });
      const image = await readBody(req, MAX_IMAGE);
      const job = startJob({ image, contentType, prompt, caption, autoPublish: false }); // 항상 확인 후 게시
      console.log(`[${job.id}] 작업 시작 — "${prompt.slice(0, 40)}"`);
      return json(res, 202, publicJob(job));
    }

    if (req.method === 'GET' && p === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      return res.end(await readFile(path.join(ROOT, 'public', 'style.css')));
    }

    if (req.method === 'GET' && (p === '/merge' || p === '/merge.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(path.join(ROOT, 'public', 'merge.html')));
    }

    if (req.method === 'GET' && p === '/api/team/status') {
      return json(res, 200, { ffmpeg: !!(await merge.findFfmpeg()) });
    }

    // 내가 만든 영상 목록
    if (req.method === 'GET' && p === '/api/videos') {
      const mine = await listMp4(DIRS.mine);
      return json(res, 200, { videos: mine.map((v) => ({ ...v, ref: `mine:${v.file}`, url: `/outputs/${v.file}` })) });
    }

    // 팀원 클립 올리기 (원래 파일 이름은 화면 표시용으로만 돌려준다)
    if (req.method === 'POST' && p === '/api/team/clips') {
      const body = await readBody(req, MAX_CLIP, '클립이 너무 큽니다 (최대 200MB).');
      if (body.length < 100) return json(res, 400, { error: '빈 파일입니다.' });
      await mkdir(DIRS.inbox, { recursive: true });
      const file = `${Date.now()}_${randomUUID().slice(0, 6)}.mp4`;
      const full = path.join(DIRS.inbox, file);
      await writeFile(full, body);
      try {
        const info = await merge.probe(full);
        return json(res, 200, { ref: `inbox:${file}`, url: `/outputs/team-inbox/${file}`, ...info });
      } catch (e) {
        await unlink(full).catch(() => {});
        return json(res, 400, { error: `${url.searchParams.get('name') || '파일'}: ${e.message}` });
      }
    }

    // 합치기 시작
    if (req.method === 'POST' && p === '/api/team/merge') {
      let body;
      try {
        body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
      } catch (e) {
        return json(res, 400, { error: 'JSON 파싱 실패: ' + e.message });
      }

      const { clips, aspect, fade } = body;

      if (!Array.isArray(clips)) {
        return json(res, 400, { error: `clips는 배열이어야 합니다. 받은 타입: ${typeof clips}` });
      }
      if (clips.length < 2) return json(res, 400, { error: '합칠 클립을 2개 이상 고르세요.' });
      if (clips.length > 100) return json(res, 400, { error: '클립은 100개까지 합칠 수 있습니다.' });

      // clips가 {ref, subtitle} 객체 배열인 경우 처리
      let files, subtitles = [];
      try {
        // 첫 번째 클립 타입 확인
        const firstClip = clips[0];
        console.log('[merge] clips 개수:', clips.length, ', 첫 번째 타입:', typeof firstClip);

        if (firstClip && typeof firstClip === 'object' && firstClip !== null && 'ref' in firstClip) {
          // 객체 배열: { ref: string, subtitle?: string }
          console.log('[merge] 객체 배열 모드');
          files = clips.map((c, i) => {
            if (!c || typeof c !== 'object' || c === null) {
              throw new Error(`클립 ${i + 1}번이 객체가 아닙니다 (타입: ${typeof c})`);
            }
            if (!c.ref || typeof c.ref !== 'string') {
              throw new Error(`클립 ${i + 1}번의 ref가 없거나 문자열이 아닙니다. 받은 값: ${JSON.stringify(c)}`);
            }
            return refPath(c.ref);
          });
          subtitles = clips.map((c) => (c && c.subtitle) || '');
        } else if (typeof firstClip === 'string') {
          // 문자열 배열 (하위 호환성)
          console.log('[merge] 문자열 배열 모드');
          files = clips.map((c, i) => {
            if (typeof c !== 'string') {
              throw new Error(`클립 ${i + 1}번이 문자열이 아닙니다 (타입: ${typeof c}, 값: ${JSON.stringify(c)})`);
            }
            return refPath(c);
          });
        } else {
          throw new Error(`알 수 없는 클립 형식입니다. 첫 번째 클립 타입: ${typeof firstClip}, 값: ${JSON.stringify(firstClip)}`);
        }
      } catch (e) {
        console.error('[merge] 클립 처리 오류:', e.message);
        return json(res, 400, { error: e.message });
      }

      await mkdir(DIRS.merged, { recursive: true });
      const id = randomUUID().slice(0, 8);
      const file = `team_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}_${id}.mp4`;
      const job = { id, state: 'running', progress: 0, file: null, error: null };
      mergeJobs.set(id, job);
      console.log(`[merge ${id}] 클립 ${files.length}개 합치기 시작 (${aspect}, 전환 ${fade}초${subtitles.some((s) => s) ? ', 자막 포함' : ''})`);
      merge.mergeClips({ files, output: path.join(DIRS.merged, file), aspect, fade, subtitles, onProgress: (r) => { job.progress = r; } })
        .then((info) => { Object.assign(job, { state: 'done', progress: 1, file, url: `/outputs/team-merged/${file}`, info }); console.log(`[merge ${id}] ✅ 완료 ${file} (${info.duration.toFixed(1)}초)`); })
        .catch((e) => { Object.assign(job, { state: 'error', error: e.message }); console.error(`[merge ${id}] ❌ ${e.message}`); });
      return json(res, 202, job);
    }

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/team\/merge\/([\w-]+)$/))) {
      const job = mergeJobs.get(m[1]);
      return job ? json(res, 200, job) : json(res, 404, { error: '작업을 찾을 수 없습니다.' });
    }

    // 합친 영상 인스타그램 게시
    if (req.method === 'POST' && (m = p.match(/^\/api\/team\/merge\/([\w-]+)\/publish$/))) {
      const job = mergeJobs.get(m[1]);
      if (!job) return json(res, 404, { error: '작업을 찾을 수 없습니다.' });
      if (job.state !== 'done') return json(res, 409, { error: '영상이 아직 완성되지 않았습니다.' });
      if (job.publishing) return json(res, 409, { error: '이미 게시 중입니다.' });

      const body = await readBody(req, 64 * 1024);
      let caption = '';
      if (body.length) {
        const parsed = JSON.parse(body.toString());
        caption = (parsed.caption || '').trim().slice(0, 2200);
      }

      job.publishing = true;
      job.publishState = 'publishing';

      // 비동기로 게시 처리
      (async () => {
        try {
          const videoPath = path.join(DIRS.merged, job.file);
          const videoBuffer = await readFile(videoPath);

          // 1. 영상을 힉스필드에 업로드하여 공개 URL 얻기
          console.log(`[merge ${job.id}] 📤 힉스필드에 영상 업로드 중...`);
          const videoUrl = await hf.uploadVideo(videoBuffer);

          // 2. 인스타그램에 게시
          console.log(`[merge ${job.id}] 📸 인스타그램에 게시 중...`);
          const ig = await import('./lib/instagram.mjs');
          const result = await ig.publishReel({
            videoUrl,
            caption,
            onStep: (step, msg) => console.log(`[merge ${job.id}] ${msg}`)
          });

          job.result = result;
          job.publishState = 'done';
          console.log(`[merge ${job.id}] ✅ 인스타 게시 완료: ${result.permalink || result.username}`);
        } catch (e) {
          job.publishError = e.message;
          job.publishState = 'error';
          console.error(`[merge ${job.id}] ❌ 인스타 게시 실패: ${e.message}`);
        } finally {
          job.publishing = false;
        }
      })();

      return json(res, 202, { state: 'publishing', message: '인스타그램에 게시 중...' });
    }

    if (req.method === 'GET' && (m = p.match(/^\/api\/jobs\/([\w-]+)$/))) {
      const job = getJob(m[1]);
      return job ? json(res, 200, publicJob(job)) : json(res, 404, { error: '작업을 찾을 수 없습니다.' });
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/jobs\/([\w-]+)\/publish$/))) {
      const job = getJob(m[1]);
      if (!job) return json(res, 404, { error: '작업을 찾을 수 없습니다.' });
      const body = await readBody(req, 64 * 1024);
      if (body.length) {
        const { caption } = JSON.parse(body.toString());
        if (typeof caption === 'string') job.caption = caption.trim().slice(0, 2200);
      }
      if (job.state !== 'ready') return json(res, 409, { error: '지금은 게시할 수 없습니다.' });
      publish(job).catch(() => {});
      return json(res, 202, publicJob(job));
    }

    if (req.method === 'POST' && (m = p.match(/^\/api\/jobs\/([\w-]+)\/cancel$/))) {
      const job = getJob(m[1]);
      if (!job) return json(res, 404, { error: '작업을 찾을 수 없습니다.' });
      if (job.state !== 'ready') return json(res, 409, { error: '지금은 취소할 수 없습니다.' });
      await cancel(job);
      return json(res, 200, publicJob(job));
    }

    if (req.method === 'GET' && (m = p.match(/^\/outputs\/(?:(team-inbox|team-merged)\/)?([^/]+)$/)) && FILE_RE.test(m[2])) {
      const file = path.join(m[1] ? path.join(OUTPUT_DIR, m[1]) : OUTPUT_DIR, m[2]);
      const { size } = await stat(file);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size });
      return createReadStream(file).pipe(res);
    }

    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

// 내 컴퓨터에서만 접속 가능 (API 키 보호)
server.listen(PORT, '127.0.0.1', async () => {
  const bot = await startTelegram();
  console.log('');
  console.log('  ✨ 인스타 제너레이터 실행 중');
  console.log(`  👉 브라우저에서 http://localhost:${PORT} 을 여세요`);
  if (process.env.MOCK === '1') console.log('  🧪 연습 모드 (MOCK=1): 실제 생성·게시·과금 없음');
  if (bot) console.log(`  🤖 텔레그램 봇 @${bot.username} 연결됨${bot.chats ? ` (허용 채팅방 ${bot.chats}개)` : ' — 봇에게 /start 를 보내 chat id 를 확인하세요'}`);
  if (bot) console.log(bot.claude ? '  🧠 Claude 연결됨 — 텔레그램에서 대화·사진 정리 가능' : '  ⚪ Claude 꺼짐 (.env 에 OPENROUTER_API_KEY 를 넣으면 켜져요)');
  console.log('  종료: Ctrl + C');
  console.log('');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`포트 ${PORT} 이 이미 사용 중입니다. 앱이 이미 켜져 있는지 확인하거나 .env 의 PORT 를 바꾸세요.`);
  else console.error(e);
  process.exit(1);
});
