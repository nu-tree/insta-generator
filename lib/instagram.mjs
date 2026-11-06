// 인스타그램 콘텐츠 게시 API — Instagram API with Unified Login (graph.facebook.com)
// 흐름: 릴스 컨테이너 생성(video_url) → status_code 가 FINISHED 될 때까지 대기 → media_publish
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cfg() {
  const token = process.env.IG_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('.env 에 IG_ACCESS_TOKEN 을 입력하세요.');
  const host = process.env.IG_GRAPH_HOST?.trim() || 'graph.facebook.com';
  const ver = process.env.IG_API_VERSION?.trim() || 'v27.0';
  return { token, base: `https://${host}/${ver}`, host };
}

async function graph(path, { method = 'GET', params = {} } = {}) {
  const { token, base } = cfg();
  const qs = new URLSearchParams({ ...params, access_token: token });
  const url = method === 'GET' ? `${base}${path}?${qs}` : `${base}${path}`;
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : qs,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    const err = new Error(`인스타그램 오류 (${res.status}${e.code ? ` / code ${e.code}` : ''}): ${e.error_user_msg || e.message || '알 수 없는 오류'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let cachedAccount = null;

/** 게시할 인스타그램 계정 ID·아이디 확인 */
export async function getAccount() {
  if (cachedAccount) return cachedAccount;
  const { host } = cfg();
  const fixedId = process.env.IG_USER_ID?.trim();

  if (host.includes('instagram.com')) {
    // (구) Instagram Login 토큰 호환
    const me = await graph('/me', { params: { fields: 'user_id,username' } });
    cachedAccount = { id: fixedId || me.user_id, username: me.username };
    return cachedAccount;
  }

  // 통합 로그인 토큰: /me 는 시스템 사용자이므로 연결된 인스타 계정을 조회
  const list = await graph('/me/assigned_instagram_accounts', { params: { fields: 'id,username' } });
  const accounts = list.data || [];
  if (fixedId) {
    cachedAccount = accounts.find((a) => a.id === fixedId) || { id: fixedId, username: '(IG_USER_ID 직접 지정)' };
  } else if (accounts.length) {
    cachedAccount = accounts[0];
  } else {
    throw new Error('토큰에 연결된 인스타그램 계정이 없습니다. 앱 대시보드의 Generate access tokens 에서 계정을 추가했는지 확인하세요.');
  }
  return cachedAccount;
}

export function resetAccountCache() { cachedAccount = null; }

/** 릴스 게시. videoUrl 은 Meta 서버가 내려받을 수 있는 공개 https URL 이어야 한다 */
export async function publishReel({ videoUrl, caption, onStep = () => {} }) {
  const acct = await getAccount();

  onStep('container', '인스타그램에 영상 전달 중');
  const params = { media_type: 'REELS', video_url: videoUrl, caption: caption || '', share_to_feed: 'true' };
  if (process.env.IG_AI_LABEL !== '0') params.is_ai_generated = 'true';
  const container = await graph(`/${acct.id}/media`, { method: 'POST', params });

  // 공식 권장: 1분에 한 번, 최대 5분. 짧은 릴스라 15초 간격으로 최대 6분까지 확인
  const started = Date.now();
  while (true) {
    const { status_code } = await graph(`/${container.id}`, { params: { fields: 'status_code' } });
    onStep('processing', `인스타그램 처리 중 (${status_code}, ${Math.round((Date.now() - started) / 1000)}초)`);
    if (status_code === 'FINISHED') break;
    if (status_code === 'ERROR') throw new Error('인스타그램이 영상 처리에 실패했습니다 (형식·길이·비율 확인).');
    if (status_code === 'EXPIRED') throw new Error('컨테이너가 만료되었습니다. 다시 시도하세요.');
    if (status_code === 'PUBLISHED') break;
    if (Date.now() - started > 6 * 60 * 1000) throw new Error('인스타그램 처리 대기 시간(6분)을 넘었습니다.');
    await sleep(15000);
  }

  onStep('publish', '게시하는 중');
  const media = await graph(`/${acct.id}/media_publish`, { method: 'POST', params: { creation_id: container.id } });

  let permalink = null;
  try {
    permalink = (await graph(`/${media.id}`, { params: { fields: 'permalink' } })).permalink;
  } catch { /* 링크 조회 실패는 게시 성공에 영향 없음 */ }

  return { mediaId: media.id, permalink, username: acct.username };
}
