// 텔레그램 봇 — 롱폴링(getUpdates) 방식이라 포트포워딩·ngrok·서버 없이 로컬에서 동작 (외부 패키지 없음)
//
// 할 수 있는 일
//  - 사진 + 캡션을 보내면 영상 생성 시작 (캡션 첫 부분 = 영상 프롬프트, '---' 아래 = 인스타 캡션)
//  - 진행 상황을 메시지 하나에서 계속 갱신
//  - 완성 영상을 미리보기로 보내고 [게시] [캡션 수정] [다시 생성] [취소] 버튼 제공
//  - 웹에서 시작한 작업도 완료·실패·게시 결과를 알림
//
// 보안: TG_CHAT_IDS 에 적힌 채팅방만 사용 가능 (비어 있으면 /start 에 chat id 만 알려 주고 아무것도 실행하지 않음)
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { startJob, getJob, publish, cancel, checkSetup, events, OUTPUT_DIR } from './pipeline.mjs';

const API = 'https://api.telegram.org';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE = 10 * 1024 * 1024;
const EDIT_INTERVAL = 4000; // 진행 메시지 수정 최소 간격 (텔레그램 속도 제한 회피)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = '';
let allowed = new Set();
let notifyWeb = true;

const tracked = new Map();        // jobId → { chatId, statusMsgId, lastText, lastAt, lastState }
const pendingCaption = new Map(); // chatId → jobId (캡션 수정 대기)

const USAGE = [
  '📸 사진을 보내고, 사진 설명(캡션)에 어떻게 움직일지 적어 주세요.',
  '',
  '인스타 캡션까지 같이 쓰려면 --- 줄로 나눠요:',
  '',
  '천천히 카메라가 다가오며 머리카락이 바람에 날린다',
  '---',
  '오늘의 한 장 ✨ #reels',
  '',
  '영상이 완성되면 미리보기와 [게시] 버튼을 보내 드려요. 버튼을 누르기 전까지는 게시되지 않아요.',
  '',
  '/status — 힉스필드·인스타 연결 상태',
].join('\n');

// ── Bot API ─────────────────────────────────────────────

async function tg(method, params = {}) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(`텔레그램 오류 (${method} ${res.status}): ${data.description || '알 수 없음'}`);
    err.status = res.status;
    throw err;
  }
  return data.result;
}

async function sendVideoFile(chatId, file, caption, markup) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', await openAsBlob(file, { type: 'video/mp4' }), path.basename(file));
  form.append('caption', caption);
  form.append('supports_streaming', 'true');
  if (markup) form.append('reply_markup', JSON.stringify(markup));
  const res = await fetch(`${API}/bot${token}/sendVideo`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`텔레그램 영상 전송 실패: ${data.description || res.status}`);
  return data.result;
}

async function downloadFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  if (f.file_size && f.file_size > MAX_IMAGE) throw new Error('이미지가 너무 큽니다 (최대 10MB).');
  const res = await fetch(`${API}/file/bot${token}/${f.file_path}`);
  if (!res.ok) throw new Error(`텔레그램 파일 다운로드 실패 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

const send = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, ...extra });
const quiet = (p) => p.catch((e) => console.error('[telegram]', e.message));
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── 알림 ────────────────────────────────────────────────

function readyButtons(id) {
  return {
    inline_keyboard: [
      [{ text: '✅ 인스타에 게시', callback_data: `pub:${id}` }, { text: '✏️ 캡션 수정', callback_data: `cap:${id}` }],
      [{ text: '🔁 다시 생성', callback_data: `re:${id}` }, { text: '🗑 취소', callback_data: `no:${id}` }],
    ],
  };
}

function readyText(job) {
  return [
    `🎬 영상 완성! [${job.id}]${job.mock ? ' · 연습 모드' : ''}`,
    `프롬프트: ${short(job.prompt, 200)}`,
    `캡션: ${job.caption ? short(job.caption, 600) : '(없음)'}`,
    '',
    '확인 후 아래 버튼을 눌러 주세요.',
  ].join('\n');
}

async function sendReady(chatId, job) {
  const file = job.localVideo && path.join(OUTPUT_DIR, job.localVideo);
  if (file) {
    try { return await sendVideoFile(chatId, file, readyText(job), readyButtons(job.id)); }
    catch (e) { console.error('[telegram]', e.message); } // 영상 전송 실패 시 글로만 알림
  }
  return send(chatId, readyText(job), { reply_markup: readyButtons(job.id) });
}

/** 이 작업의 알림을 받을 채팅방들 */
function targets(job) {
  const t = tracked.get(job.id);
  if (t?.chatId) return [t.chatId];
  return job.source === 'web' && notifyWeb ? [...allowed] : [];
}

async function onUpdate(job) {
  const chats = targets(job);
  if (!chats.length) return;
  let t = tracked.get(job.id);
  if (!t) { t = { chatId: null, statusMsgId: null, lastText: '', lastAt: 0, lastState: 'running' }; tracked.set(job.id, t); }

  const prev = t.lastState;
  t.lastState = job.state;

  // 진행 중: 상태 메시지 하나를 계속 고쳐 쓴다 (텔레그램에서 시작한 작업만)
  if (job.state === 'running' || job.state === 'publishing') {
    if (!t.statusMsgId) return;
    const text = `⏳ [${job.id}] ${job.message}`;
    if (text === t.lastText || Date.now() - t.lastAt < EDIT_INTERVAL) return;
    t.lastText = text; t.lastAt = Date.now();
    return quiet(tg('editMessageText', { chat_id: t.chatId, message_id: t.statusMsgId, text }));
  }
  if (prev === job.state) return;

  if (t.statusMsgId) {
    const done = { ready: '영상 완성', done: '게시 완료', error: '실패', canceled: '취소됨' }[job.state] || job.state;
    quiet(tg('editMessageText', { chat_id: t.chatId, message_id: t.statusMsgId, text: `☑️ [${job.id}] ${done}` }));
  }

  for (const chatId of chats) {
    if (job.state === 'ready' && prev === 'publishing') {
      // 게시 실패 → 영상은 남아 있으니 다시 시도 가능
      await quiet(send(chatId, `⚠️ [${job.id}] 게시 실패\n${job.error}`, { reply_markup: readyButtons(job.id) }));
    } else if (job.state === 'ready') {
      await quiet(sendReady(chatId, job));
    } else if (job.state === 'done') {
      const r = job.result || {};
      await quiet(send(chatId, `✅ [${job.id}] 게시 완료! @${r.username || ''}\n${r.permalink || ''}`.trim()));
    } else if (job.state === 'error') {
      const markup = job.input ? { inline_keyboard: [[{ text: '🔁 다시 생성', callback_data: `re:${job.id}` }]] } : undefined;
      await quiet(send(chatId, `❌ [${job.id}] ${job.error}`, markup ? { reply_markup: markup } : {}));
    }
  }
  if (['done', 'error', 'canceled'].includes(job.state)) setTimeout(() => tracked.delete(job.id), 60 * 60 * 1000);
}

// ── 들어오는 메시지 ──────────────────────────────────────

function parseText(text = '') {
  const parts = text.split(/^\s*-{3,}\s*$/m);
  return { prompt: parts[0].trim(), caption: parts.slice(1).join('\n').trim() };
}

async function begin(chatId, { image, contentType, prompt, caption }) {
  const status = await send(chatId, `⏳ 작업 준비 중 — "${short(prompt, 60)}"`);
  const job = startJob({ image, contentType, prompt, caption, autoPublish: false, source: 'telegram' });
  tracked.set(job.id, { chatId, statusMsgId: status.message_id, lastText: '', lastAt: 0, lastState: job.state });
  console.log(`[${job.id}] 작업 시작 (텔레그램) — "${prompt.slice(0, 40)}"`);
  quiet(tg('editMessageText', { chat_id: chatId, message_id: status.message_id, text: `⏳ [${job.id}] ${job.message}` }));
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (!allowed.has(String(chatId))) {
    if (text.startsWith('/start')) {
      await send(chatId, `이 채팅방의 chat id 는 ${chatId} 입니다.\n.env 의 TG_CHAT_IDS 에 넣고 앱을 다시 켜 주세요.`);
      console.log(`[telegram] 허용되지 않은 채팅방에서 /start — chat id: ${chatId} (.env 의 TG_CHAT_IDS 에 추가하세요)`);
    }
    return;
  }

  if (text === '/start' || text === '/help') return send(chatId, USAGE);
  if (text === '/status') {
    const s = await checkSetup();
    const hf = s.higgsfield.ok ? '✅ 힉스필드 연결됨' : `❌ 힉스필드: ${s.higgsfield.error}`;
    const ig = s.instagram.ok ? `✅ 인스타 @${s.instagram.username}` : `❌ 인스타: ${s.instagram.error}`;
    return send(chatId, `${s.mock ? '🧪 연습 모드\n' : ''}${hf}\n${ig}`);
  }

  // 캡션 수정 대기 중이면 이 글을 새 캡션으로
  if (text && !text.startsWith('/') && pendingCaption.has(chatId)) {
    const job = getJob(pendingCaption.get(chatId));
    pendingCaption.delete(chatId);
    if (!job || job.state !== 'ready') return send(chatId, '이 작업은 더 이상 수정할 수 없어요.');
    if (text.length > 2200) return send(chatId, '캡션은 2200자 이하여야 합니다.');
    job.caption = text;
    return send(chatId, `✏️ 캡션을 바꿨어요.\n\n${readyText(job)}`, { reply_markup: readyButtons(job.id) });
  }

  let fileId, contentType;
  if (msg.photo?.length) {
    fileId = msg.photo.at(-1).file_id; // 가장 큰 해상도
    contentType = 'image/jpeg';
  } else if (msg.document && IMAGE_TYPES.includes(msg.document.mime_type)) {
    fileId = msg.document.file_id;
    contentType = msg.document.mime_type;
  } else if (msg.document) {
    return send(chatId, 'JPG, PNG, WEBP 이미지만 사용할 수 있어요.');
  }

  if (!fileId) return send(chatId, USAGE);

  const { prompt, caption } = parseText(msg.caption);
  if (!prompt) return send(chatId, '사진 설명(캡션)에 어떻게 움직일지 적어서 다시 보내 주세요.\n예: 천천히 카메라가 다가오며 머리카락이 바람에 날린다');
  if (caption.length > 2200) return send(chatId, '인스타 캡션은 2200자 이하여야 합니다.');

  const image = await downloadFile(fileId);
  await begin(chatId, { image, contentType, prompt, caption });
}

async function onCallback(cb) {
  const chatId = cb.message?.chat.id;
  const answer = (text) => quiet(tg('answerCallbackQuery', { callback_query_id: cb.id, text }));
  if (!allowed.has(String(chatId))) return answer('허용되지 않은 채팅방입니다.');

  const [action, id] = (cb.data || '').split(':');
  const job = getJob(id);
  if (!job) return answer('작업을 찾을 수 없어요 (앱이 다시 켜졌을 수 있어요).');
  const dropButtons = () => quiet(tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }));

  if (action === 'pub') {
    if (job.state !== 'ready') return answer(`지금은 게시할 수 없어요 (${job.state}).`);
    if (!tracked.has(job.id)) tracked.set(job.id, { chatId, statusMsgId: null, lastText: '', lastAt: 0, lastState: job.state });
    else tracked.get(job.id).chatId = chatId;
    // 진행 상황을 보여 줄 새 상태 메시지
    const status = await send(chatId, `⏳ [${job.id}] 인스타그램 게시 시작`);
    Object.assign(tracked.get(job.id), { statusMsgId: status.message_id, lastText: '', lastAt: 0 });
    publish(job).catch(() => {}); // 결과는 onUpdate 가 알림
    dropButtons();
    return answer('게시를 시작했어요.');
  }

  if (action === 'cap') {
    if (job.state !== 'ready') return answer(`지금은 수정할 수 없어요 (${job.state}).`);
    pendingCaption.set(chatId, job.id);
    await send(chatId, `새 인스타 캡션을 보내 주세요.\n\n현재 캡션: ${job.caption || '(없음)'}`, { reply_markup: { force_reply: true } });
    return answer();
  }

  if (action === 're') {
    if (!job.input) return answer('원본 이미지가 없어 다시 만들 수 없어요.');
    if (!['ready', 'error'].includes(job.state)) return answer(`지금은 다시 만들 수 없어요 (${job.state}).`);
    dropButtons();
    answer('다시 생성할게요.');
    if (job.state === 'ready') await cancel(job).catch(() => {});
    return begin(chatId, { ...job.input, prompt: job.prompt, caption: job.caption });
  }

  if (action === 'no') {
    if (job.state !== 'ready') return answer(`지금은 취소할 수 없어요 (${job.state}).`);
    await cancel(job);
    dropButtons();
    await send(chatId, `🗑 [${job.id}] 취소했어요. 인스타에 올라가지 않았어요.`);
    return answer('취소했어요.');
  }

  return answer();
}

// ── 롱폴링 루프 ─────────────────────────────────────────

async function poll() {
  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    } catch (e) {
      if (e.status === 401 || e.status === 404) { console.error('[telegram] ❌ TG_BOT_TOKEN 이 올바르지 않습니다. 봇을 끕니다.'); return; }
      if (e.status === 409) console.error('[telegram] 다른 곳에서 같은 봇을 실행 중이거나 웹훅이 설정돼 있습니다. 5초 후 다시 시도합니다.');
      else console.error('[telegram]', e.message);
      await sleep(5000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) {
        console.error('[telegram]', e.message);
        const chatId = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
        if (chatId && allowed.has(String(chatId))) await quiet(send(chatId, `❌ ${e.message}`));
      }
    }
  }
}

/** 서버 시작 시 호출. TG_BOT_TOKEN 이 없으면 아무것도 하지 않는다 */
export async function startTelegram() {
  token = process.env.TG_BOT_TOKEN?.trim() || '';
  if (!token) return null;
  allowed = new Set((process.env.TG_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
  notifyWeb = process.env.TG_NOTIFY_WEB?.trim() !== '0';

  let me;
  try { me = await tg('getMe'); }
  catch (e) { console.error(`[telegram] ❌ 봇 연결 실패: ${e.message}`); return null; }

  events.on('update', (job) => { onUpdate(job).catch((e) => console.error('[telegram]', e.message)); });
  poll();
  return { username: me.username, chats: allowed.size };
}
