// publish/publish.mjs — GitHub Actions 예약 발행기 (Node 20+, 전역 fetch)
// 지연·부분실패에 견디는 설계:
//   ① 발행 창 가드: KST 11~22시에만 발행(크론 지연으로 새벽/심야 발행 방지)
//   ② 하루 1배치: published._lastBatchKST == 오늘이면 스킵(같은 날 여러 크론 중 1회만)
//   ③ 오래된 배치 우선: publishDate <= 오늘 & 미발행 중 가장 이른 publishDate 배치만 발행(누락분 catch-up, 몰아치기 방지)
//   ④ 마커: 각 발행 즉시 published.json 기록 + 워크플로우가 커밋(중복 발행 방지)
// 환경변수: INSTA_TOKEN_B1/B2/B3(Secrets) · PUBLISH_DRY=1(선택만) · PUBLISH_DATE_OVERRIDE=YYYY-MM-DD · PUBLISH_HOUR_OVERRIDE=0~23
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const IG = 'https://graph.instagram.com/v21.0';
const BASE = 'https://cdn.jsdelivr.net/gh/ghinioh/nextcandle-assets@main';
const ACCOUNTS = { B1: '17841416465390980', B2: '17841411920710980', B3: '17841423551881134' };
const DRY = process.env.PUBLISH_DRY === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000); // KST를 UTC로 시프트한 Date
const kstDate = () => kstNow().toISOString().slice(0, 10);
const kstHour = () => kstNow().getUTCHours();

const schedule = JSON.parse(fs.readFileSync(path.join(__dir, 'schedule.json'), 'utf8'));
const pubFile = path.join(__dir, 'published.json');
const published = fs.existsSync(pubFile) ? JSON.parse(fs.readFileSync(pubFile, 'utf8')) : {};

const today = process.env.PUBLISH_DATE_OVERRIDE || kstDate();
const hour = process.env.PUBLISH_HOUR_OVERRIDE != null && process.env.PUBLISH_HOUR_OVERRIDE !== '' ? +process.env.PUBLISH_HOUR_OVERRIDE : kstHour();

// ① 발행 창 가드(KST 11~22시). DRY는 무시.
if (!DRY && !(hour >= 11 && hour < 22)) { console.log(`[${today} ${hour}시KST] 발행 창(11~22) 밖 — 대기`); process.exit(0); }
// ② 하루 1배치 가드
if (!DRY && published._lastBatchKST === today) { console.log(`[${today}] 오늘 배치 이미 발행됨 — 대기`); process.exit(0); }

// ③ publishDate <= 오늘 & 미발행 → 가장 이른 publishDate 배치만
const pending = [];
for (const entry of schedule) {
  if (entry.publishDate > today) continue;
  for (const it of entry.items) {
    const id = `${it.key}_${it.dateLabel}`;
    if (published[id]) continue;
    pending.push({ ...it, id, publishDate: entry.publishDate });
  }
}
if (!pending.length) { console.log(`[${today}] 발행 대기분 없음 — 종료`); process.exit(0); }
const oldest = pending.reduce((m, p) => (p.publishDate < m ? p.publishDate : m), pending[0].publishDate);
const batch = pending.filter((p) => p.publishDate === oldest);
console.log(`[${today} ${hour}시KST] 배치 ${oldest} · ${batch.length}건: ${batch.map((b) => b.id).join(', ')}${DRY ? ' (DRY)' : ''}`);

async function post(acc, p, params, token) {
  const r = await fetch(`${IG}/${acc}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, access_token: token }) });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(JSON.stringify(d.error || d));
  return d;
}
async function recentPostWithin(acc, token, ms) {
  const r = await fetch(`${IG}/${acc}/media?fields=id,timestamp&limit=1&access_token=${encodeURIComponent(token)}`);
  const j = await r.json();
  const latest = j.data && j.data[0];
  if (latest && latest.timestamp && Date.now() - new Date(latest.timestamp).getTime() < ms) return latest.id;
  return null;
}
async function publishOne(it) {
  const token = process.env['INSTA_TOKEN_' + it.key];
  const acc = ACCOUNTS[it.key];
  if (!token) throw new Error(`INSTA_TOKEN_${it.key} 미설정`);
  const videoUrl = `${BASE}/${it.key}/${it.dateLabel}/video/reels.mp4`;
  const coverUrl = `${BASE}/${it.key}/${it.dateLabel}/video/cover.jpg`;
  const caption = fs.readFileSync(path.join(__dir, 'captions', `${it.id}.txt`), 'utf8').trim();
  if (DRY) { console.log(`  DRY ${it.id} · ${videoUrl} · capLen=${caption.length}`); return 'DRY'; }
  const cd = await post(acc, 'media', { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true', cover_url: coverUrl }, token);
  let status = '';
  for (let i = 0; i < 60; i++) {
    const sr = await fetch(`${IG}/${cd.id}?fields=status_code&access_token=${encodeURIComponent(token)}`);
    const sd = await sr.json();
    if (sd.error) throw new Error('상태확인 실패: ' + JSON.stringify(sd.error));
    status = sd.status_code;
    if (status === 'FINISHED') break;
    if (status === 'ERROR') throw new Error('컨테이너 처리 ERROR');
    await sleep(5000);
  }
  if (status !== 'FINISHED') throw new Error('컨테이너 준비 시간초과 status=' + status);
  try {
    const pd = await post(acc, 'media_publish', { creation_id: cd.id }, token);
    return pd.id;
  } catch (e) {
    await sleep(4000);
    const recent = await recentPostWithin(acc, token, 180000);
    if (recent) return recent;
    throw e;
  }
}

let ok = 0, fail = 0;
for (const it of batch) {
  try {
    const mediaId = await publishOne(it);
    if (!DRY) {
      published[it.id] = { mediaId, at: new Date().toISOString(), kst: today };
      fs.writeFileSync(pubFile, JSON.stringify(published, null, 2) + '\n');
    }
    console.log(`🚀 ${it.id} → ${mediaId}`);
    ok++;
    if (!DRY) await sleep(30000); // 계정 간 간격
  } catch (e) {
    console.error(`❌ ${it.id}: ${e.message}`);
    fail++;
  }
}
// 최소 1건 성공 시 오늘 배치 완료 표시(전부 실패면 다음 창에서 재시도)
if (!DRY && ok > 0) {
  published._lastBatchKST = today;
  fs.writeFileSync(pubFile, JSON.stringify(published, null, 2) + '\n');
}
console.log(`완료: 성공 ${ok} / 실패 ${fail}`);
// 부분실패라도 정상 종료(마커 커밋 보장). 실패분은 다음 날 catch-up.
process.exit(0);
