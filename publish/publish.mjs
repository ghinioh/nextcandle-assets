// publish/publish.mjs — GitHub Actions 예약 발행기 (Node 20+, 전역 fetch)
// 오늘(KST) 예정분 중 아직 발행 안 된 릴스를 인스타(Instagram Login API)로 발행하고
// published.json에 마커를 남긴다(중복 발행 방지). 워크플로우가 published.json을 커밋해 상태 유지.
//
// 환경변수: INSTA_TOKEN_B1 / INSTA_TOKEN_B2 / INSTA_TOKEN_B3 (GitHub Secrets)
//           PUBLISH_DRY=1  → API 호출 없이 선택만 출력
//           PUBLISH_DATE_OVERRIDE=YYYY-MM-DD → 오늘 날짜 강제(테스트용)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const IG = 'https://graph.instagram.com/v21.0';
const BASE = 'https://cdn.jsdelivr.net/gh/ghinioh/nextcandle-assets@main';
const ACCOUNTS = { B1: '17841416465390980', B2: '17841411920710980', B3: '17841423551881134' };
const DRY = process.env.PUBLISH_DRY === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const schedule = JSON.parse(fs.readFileSync(path.join(__dir, 'schedule.json'), 'utf8'));
const pubFile = path.join(__dir, 'published.json');
const published = fs.existsSync(pubFile) ? JSON.parse(fs.readFileSync(pubFile, 'utf8')) : {};
const today = process.env.PUBLISH_DATE_OVERRIDE || nowKST();

const due = [];
for (const entry of schedule) {
  if (entry.publishDate !== today) continue;
  for (const it of entry.items) {
    const id = `${it.key}_${it.dateLabel}`;
    if (published[id]) continue;
    due.push({ ...it, id, publishDate: entry.publishDate });
  }
}

if (!due.length) { console.log(`[${today}] 예정 발행분 없음 — 종료`); process.exit(0); }
console.log(`[${today}] 발행 대상 ${due.length}건: ${due.map((d) => d.id).join(', ')}${DRY ? ' (DRY)' : ''}`);

async function post(acc, p, params, token) {
  const r = await fetch(`${IG}/${acc}/${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, access_token: token }),
  });
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
  if (!acc) throw new Error(`계정 ID 없음 ${it.key}`);
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

  // 발행 — 정확히 1회(비멱등). 에러 시 최근 게시물로 성공 여부 확인.
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
for (const it of due) {
  try {
    const mediaId = await publishOne(it);
    if (!DRY) {
      published[it.id] = { mediaId, at: new Date().toISOString(), publishDate: it.publishDate };
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
console.log(`완료: 성공 ${ok} / 실패 ${fail}`);
if (fail) process.exit(1);
