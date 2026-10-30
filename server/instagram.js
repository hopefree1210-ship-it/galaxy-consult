// Instagram 메시징(DM) 연동: 웹훅 수신 → 일본어 자동 안내(상담 링크) 발송
import crypto from 'node:crypto';
import { db } from './db.js';

const env = () => ({
  verify: process.env.IG_VERIFY_TOKEN, secret: process.env.IG_APP_SECRET, token: process.env.IG_ACCESS_TOKEN,
  ver: process.env.IG_API_VERSION || 'v21.0', base: (process.env.BASE_URL || '').replace(/\/$/, ''),
});
export const igConfigured = () => { const e = env(); return !!(e.verify && e.secret && e.token && e.base); };

export function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
export const consultLink = igsid => `${env().base}/?src=ig&ref=${encodeURIComponent(igsid)}`;
export const welcomeText = igsid =>
  `メッセージありがとうございます。별성형외과のオンライン事前相談です🌟\n` +
  `希望の施術と写真を送るだけで、費用と滞在日数の目安がすぐにわかります。\n${consultLink(igsid)}\n` +
  `※オンライン相談は診断・治療ではなく、情報提供と来院前の事前相談です。`;

export async function sendDm(igsid, text) {
  const e = env();
  const r = await fetch(`https://graph.instagram.com/${e.ver}/me/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${e.token}` },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  });
  if (!r.ok) throw new Error(`instagram send ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

const DAY = 24 * 3600e3;
export async function handleWebhook(body, send = sendDm) {
  const out = [];
  for (const entry of body.entry || []) for (const ev of entry.messaging || []) {
    const igsid = ev.sender?.id; if (!igsid || ev.message?.is_echo || !ev.message) continue;
    const now = Date.now(), row = db.prepare('select * from ig_contacts where igsid=?').get(igsid);
    if (row && now - row.last_reply_at < DAY) { out.push({ igsid, skipped: 'recent' }); continue; }
    try {
      await send(igsid, welcomeText(igsid));
      db.prepare('insert into ig_contacts(igsid,first_at,last_reply_at) values(?,?,?) on conflict(igsid) do update set last_reply_at=excluded.last_reply_at').run(igsid, row?.first_at || now, now);
      out.push({ igsid, replied: true });
    } catch (e) { console.error(e.message); out.push({ igsid, error: true }); }
  }
  return out;
}
// 직원이 답변했을 때 인스타 DM으로 "새 메시지" 알림 (6시간에 1회, 24시간 응답창 내에서만 가능)
export async function nudge(igsid) {
  if (!igConfigured() || !igsid) return;
  const row = db.prepare('select * from ig_contacts where igsid=?').get(igsid), now = Date.now();
  if (!row || now - row.last_notify_at < 6 * 3600e3) return;
  try {
    await sendDm(igsid, `별성형외과からチャットに新しいメッセージが届いています。\n${consultLink(igsid)}`);
    db.prepare('update ig_contacts set last_notify_at=? where igsid=?').run(now, igsid);
  } catch (e) { console.error(e.message); }
}
