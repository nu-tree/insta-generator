// 힉스필드 공식 REST API (https://docs.higgsfield.ai)
// 흐름: 업로드 URL 발급 → 이미지 PUT → 영상 생성 요청 → 상태 폴링 → video.url
const BASE = 'https://api.higgsfield.ai';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeader() {
  const id = process.env.HF_API_KEY_ID?.trim();
  const secret = process.env.HF_API_KEY_SECRET?.trim();
  if (!id || !secret) throw new Error('.env 에 HF_API_KEY_ID / HF_API_KEY_SECRET 를 입력하세요.');
  return { Authorization: `Key ${id}:${secret}` };
}

async function hf(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...authHeader(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? data);
    const err = new Error(`힉스필드 오류 (${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 키가 맞는지 확인: 없는 요청 ID 조회 → 404면 인증 OK, 401이면 키 오류 */
export async function checkCredentials() {
  try {
    await hf('/requests/00000000-0000-0000-0000-000000000000/status');
    return { ok: true };
  } catch (e) {
    if (e.status === 404 || e.status === 422) return { ok: true };
    return { ok: false, error: e.message };
  }
}

/** 로컬 이미지(Buffer)를 힉스필드 저장소에 올리고 공개 URL을 돌려준다 */
export async function uploadImage(buffer, contentType) {
  const slot = await hf('/files/generate-upload-url', {
    method: 'POST',
    body: { content_type: contentType },
  });
  // 주의: 사전서명 URL에는 힉스필드 키를 보내지 않는다 (공식 문서 지침)
  const put = await fetch(slot.upload_url, {
    method: 'PUT',
    headers: slot.upload_headers ?? { 'Content-Type': contentType },
    body: buffer,
  });
  if (!put.ok) throw new Error(`이미지 업로드 실패 (${put.status})`);
  return slot.public_url;
}

/** 이미지 → 영상 생성 요청. request_id 반환 */
export async function submitImageToVideo({ imageUrl, prompt, duration = 5 }) {
  const model = (process.env.HF_MODEL || 'kling-video/v2.5-turbo/standard/image-to-video').replace(/^\/+/, '');
  const data = await hf(`/${model}`, {
    method: 'POST',
    body: { image_url: imageUrl, prompt, duration },
  });
  if (!data.request_id) throw new Error('힉스필드 응답에 request_id 가 없습니다: ' + JSON.stringify(data));
  return data.request_id;
}

/** 완료될 때까지 폴링 (2초 시작, 1.5배씩, 최대 10초 간격 / 전체 최대 15분) */
export async function waitForVideo(requestId, onTick = () => {}) {
  const started = Date.now();
  let delay = 2000;
  while (Date.now() - started < 15 * 60 * 1000) {
    let s;
    try {
      s = await hf(`/requests/${requestId}/status`);
    } catch (e) {
      if (e.status === 401 || e.status === 404) throw e;
      s = { status: 'retrying' }; // 5xx·네트워크 오류는 재시도
    }
    onTick(s.status, Math.round((Date.now() - started) / 1000));
    if (s.status === 'completed') {
      const url = s.video?.url;
      if (!url) throw new Error('완료됐지만 영상 URL이 없습니다: ' + JSON.stringify(s));
      return url;
    }
    if (s.status === 'nsfw') throw new Error('힉스필드가 부적절한 콘텐츠로 판단해 생성을 거부했습니다 (nsfw). 다른 이미지를 사용하세요.');
    if (s.status === 'failed') throw new Error('영상 생성 실패: ' + (s.error || '원인 미상'));
    if (s.status === 'canceled') throw new Error('영상 생성이 취소되었습니다.');
    await sleep(delay + Math.random() * 500);
    delay = Math.min(delay * 1.5, 10000);
  }
  throw new Error('영상 생성이 15분 안에 끝나지 않았습니다.');
}
