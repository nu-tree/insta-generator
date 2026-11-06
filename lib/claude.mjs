// Claude 연결 (OpenRouter 경유, 외부 패키지 없음)
//  - chat(): 텔레그램 대화에 답하기 (채팅방별 최근 대화 기억)
//  - suggest(): 사진을 보고 영상 움직임 프롬프트 + 인스타 캡션 써 주기
//
// .env: OPENROUTER_API_KEY (없으면 꺼짐), CLAUDE_MODEL (기본 anthropic/claude-sonnet-4.5)
const URL = 'https://openrouter.ai/api/v1/chat/completions';
const HISTORY_TURNS = 10; // 채팅방별로 기억할 최근 주고받기 수

const key = () => process.env.OPENROUTER_API_KEY?.trim() || '';
const model = () => process.env.CLAUDE_MODEL?.trim() || 'anthropic/claude-sonnet-4.5';
export const enabled = () => Boolean(key());

const SYSTEM = `너는 '인스타 제너레이터' 텔레그램 봇의 AI 비서야.
이 봇은 사진 한 장을 힉스필드로 5초 영상으로 만들고, 사용자가 확인 버튼을 누르면 인스타그램 릴스로 게시해.

봇 사용법 (사용자가 물으면 안내해):
- 사진 + 사진 설명(캡션)에 움직임을 적어 보내면 영상 생성 시작. '---' 줄 아래는 인스타 캡션.
- 사진만 보내면 AI가 움직임 프롬프트와 인스타 캡션을 제안하고 [이대로 만들기] 버튼을 줌.
- 영상이 완성되면 [게시] [캡션 수정] [다시 생성] [취소] 버튼. 버튼을 누르기 전엔 절대 게시되지 않음.
- /status: 힉스필드·인스타·Claude 연결 상태, /reset: 대화 기억 지우기.
- 화질이 중요하면 사진을 '파일'로 보내기.

말투: 해요체 존댓말, 짧고 친근하게. 텔레그램이라 마크다운 기호(**, #)는 쓰지 마.
인스타 캡션·해시태그·릴스 아이디어·영상 프롬프트 작성을 적극적으로 도와줘.
네가 직접 영상을 만들거나 게시할 수는 없어. 그건 사진을 보내야 시작돼.`;

const SUGGEST = `이 사진으로 5초짜리 인스타 릴스 영상을 만들 거야. 아래 JSON 하나만 출력해 (다른 글 없이):
{"prompt": "...", "caption": "..."}
- prompt: 이미지→영상 모델에 줄 움직임 묘사, 한국어 한 문장. 카메라 움직임과 피사체의 자연스러운 움직임 위주로, 5초에 맞게 과하지 않게.
- caption: 인스타 캡션, 한국어 1~3줄 + 어울리는 해시태그 3~6개. 이모지는 1~2개만.`;

const history = new Map(); // chatId → [{role, content}]

async function call(messages, { maxTokens = 800 } = {}) {
  if (!enabled()) throw new Error('Claude 연결이 꺼져 있어요 (.env 의 OPENROUTER_API_KEY 를 확인하세요).');
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
      'X-Title': 'insta-generator',
    },
    body: JSON.stringify({ model: model(), max_tokens: maxTokens, messages }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || res.statusText;
    if (res.status === 401) throw new Error('Claude 키가 올바르지 않아요 (OPENROUTER_API_KEY 확인).');
    if (res.status === 402) throw new Error('OpenRouter 크레딧(한도)이 부족해요.');
    throw new Error(`Claude 오류 (${res.status}): ${msg}`);
  }
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Claude 응답이 비어 있어요.');
  return text.trim();
}

/** 텔레그램 대화 답장 */
export async function chat(chatId, text) {
  const past = history.get(chatId) || [];
  const reply = await call([{ role: 'system', content: SYSTEM }, ...past, { role: 'user', content: text }]);
  const next = [...past, { role: 'user', content: text }, { role: 'assistant', content: reply }];
  history.set(chatId, next.slice(-HISTORY_TURNS * 2));
  return reply;
}

export const resetChat = (chatId) => history.delete(chatId);

/** 사진 → { prompt, caption } 제안 */
export async function suggest(image, contentType, hint = '') {
  const content = [
    { type: 'image_url', image_url: { url: `data:${contentType};base64,${image.toString('base64')}` } },
    { type: 'text', text: SUGGEST + (hint ? `\n\n사용자 요청: ${hint}` : '') },
  ];
  const raw = await call([{ role: 'user', content }], { maxTokens: 600 });
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  let out;
  // 문자열 안에 줄바꿈을 그대로 넣는 경우가 있어 이스케이프해서 다시 시도
  const fixed = json?.replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\r?\n/g, '\\n'));
  try { out = JSON.parse(json); } catch {
    try { out = JSON.parse(fixed); } catch { throw new Error('Claude 제안을 읽지 못했어요. 다시 보내 주세요.'); }
  }
  const prompt = String(out.prompt || '').trim();
  if (!prompt) throw new Error('Claude가 움직임 프롬프트를 만들지 못했어요.');
  return { prompt, caption: String(out.caption || '').trim().slice(0, 2200) };
}

/** 연결 확인 (/status 용) — 과금 없는 키 조회 */
export async function check() {
  if (!enabled()) return { ok: false, error: '꺼짐 (OPENROUTER_API_KEY 없음)' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: res.status === 401 ? '키가 올바르지 않아요' : `오류 ${res.status}` };
    const d = (await res.json()).data || {};
    const left = d.limit != null ? ` · 남은 한도 $${(d.limit - (d.usage || 0)).toFixed(2)}` : '';
    return { ok: true, model: model(), note: left };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
