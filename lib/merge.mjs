// 여러 mp4 클립 → 영상 하나로 합치기 (ffmpeg)
// - 클립마다 크기·비율이 달라도 같은 화면 비율로 맞추고, 남는 곳은 흐린 배경으로 채운다
// - 컷 사이 페이드 전환(xfade) 선택 가능
// ffmpeg 찾는 순서: .env 의 FFMPEG_PATH → npm 의 ffmpeg-static → 시스템 PATH 의 ffmpeg
import { spawn } from 'node:child_process';

export const ASPECTS = {
  '9:16': [1080, 1920], // 릴스·쇼츠 세로
  '16:9': [1920, 1080], // 유튜브 가로
  '1:1': [1080, 1080],
};

function run(bin, args, onLine) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(bin, args, { windowsHide: true }); } catch { return resolve({ code: -1, stderr: '' }); }
    let stderr = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-20000);
      if (onLine) s.split(/\r|\n/).forEach((l) => l && onLine(l));
    });
    p.stdout.on('data', () => {});
    p.on('error', () => resolve({ code: -1, stderr }));
    p.on('close', (code) => resolve({ code, stderr }));
  });
}

let ffmpegPath;
export async function findFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  const cands = [];
  if (process.env.FFMPEG_PATH?.trim()) cands.push(process.env.FFMPEG_PATH.trim());
  try { const m = await import('ffmpeg-static'); if (m.default) cands.push(m.default); } catch { /* 설치 안 됨 */ }
  cands.push('ffmpeg');
  for (const c of cands) {
    if ((await run(c, ['-hide_banner', '-version'])).code === 0) return (ffmpegPath = c);
  }
  return null;
}

async function ffmpeg() {
  const bin = await findFfmpeg();
  if (!bin) throw new Error('ffmpeg 를 찾을 수 없습니다. 앱 폴더에서 npm install 을 실행하세요.');
  return bin;
}

const toSec = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

/** 영상 길이·크기 확인. 영상이 아니면 오류 */
export async function probe(file) {
  const { stderr } = await run(await ffmpeg(), ['-hide_banner', '-i', file]);
  const d = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const v = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  if (!d || !v) throw new Error('영상 파일을 읽을 수 없습니다.');
  return { duration: toSec(d[1], d[2], d[3]), width: Number(v[1]), height: Number(v[2]) };
}

/**
 * @param {object} o
 * @param {string[]} o.files 순서대로 합칠 mp4 경로
 * @param {string} o.output 결과 파일 경로
 * @param {'9:16'|'16:9'|'1:1'} [o.aspect]
 * @param {number} [o.fade] 전환 길이(초). 0이면 바로 이어 붙임
 * @param {(ratio:number)=>void} [o.onProgress]
 */
export async function mergeClips({ files, output, aspect = '9:16', fade = 0.3, onProgress = () => {} }) {
  if (files.length < 2) throw new Error('합칠 클립을 2개 이상 고르세요.');
  const [W, H] = ASPECTS[aspect] || ASPECTS['9:16'];
  const bin = await ffmpeg();
  const infos = [];
  for (const f of files) infos.push(await probe(f));

  fade = Math.max(0, Math.min(Number(fade) || 0, 1));
  const shortest = Math.min(...infos.map((i) => i.duration));
  if (fade && fade >= shortest / 2) fade = Math.round((shortest / 3) * 100) / 100;

  // 클립별: 30fps로 맞추고 → 흐린 배경(화면 꽉 채움) 위에 원본을 비율 그대로 올린다
  const bw = Math.round(W / 4 / 2) * 2, bh = Math.round(H / 4 / 2) * 2; // 흐림은 작은 크기에서 (빠름)
  const parts = files.map((_, i) => [
    `[${i}:v]fps=30,setsar=1,split[a${i}][b${i}]`,
    `[a${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=12:2,scale=${W}:${H},eq=brightness=-0.08[bg${i}]`,
    `[b${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg${i}]`,
    `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,settb=AVTB[v${i}]`,
  ].join(';'));

  let chain, total;
  if (!fade) {
    chain = `${files.map((_, i) => `[v${i}]`).join('')}concat=n=${files.length}:v=1:a=0[out]`;
    total = infos.reduce((s, i) => s + i.duration, 0);
  } else {
    const steps = []; let prev = 'v0'; let acc = infos[0].duration;
    for (let i = 1; i < files.length; i++) {
      const offset = (acc - fade).toFixed(3);
      const out = i === files.length - 1 ? 'out' : `x${i}`;
      steps.push(`[${prev}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset}[${out}]`);
      prev = out; acc = acc - fade + infos[i].duration;
    }
    chain = steps.join(';');
    total = acc;
  }

  const args = ['-hide_banner', '-y'];
  for (const f of files) args.push('-i', f);
  args.push(
    '-filter_complex', [...parts, chain].join(';'),
    '-map', '[out]', '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    '-movflags', '+faststart', output,
  );

  const { code, stderr } = await run(bin, args, (line) => {
    const t = line.match(/time=(\d+):(\d+):([\d.]+)/);
    if (t) onProgress(Math.min(0.99, toSec(t[1], t[2], t[3]) / total));
  });
  if (code !== 0) {
    const last = stderr.trim().split(/\r?\n/).slice(-3).join(' / ');
    throw new Error('영상 합치기 실패: ' + last);
  }
  onProgress(1);
  return { duration: total, width: W, height: H, clips: files.length };
}
