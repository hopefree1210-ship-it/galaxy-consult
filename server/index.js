import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, messages, getCfg, setCfg, db } from './db.js';
import { estimate, triage, SYMPTOM_LEVEL, PROC_EN } from './logic.js';
import { verifySignature, handleWebhook, nudge, igConfigured } from './instagram.js';

export const app = express();
const PROD = process.env.NODE_ENV === 'production';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || (PROD ? '' : 'galaxy-dev');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (PROD && !STAFF_PASSWORD) throw new Error('STAFF_PASSWORD is required in production');
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ---------- 공통 ---------- */
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': req.path.startsWith('/api') ? 'no-store' : 'no-cache' });
  next();
});
app.use(express.json({ limit: '3mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hits = new Map();
const limit = (key, max, ms) => (req, res, next) => {
  const k = key + ':' + req.ip, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= max) return res.status(429).json({ error: 'rate_limited' });
  a.push(now); hits.set(k, a); next();
};
const validPhoto = p => typeof p === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p) && p.length < 500_000;

/* ---------- 직원 인증 (비밀번호 + 서명된 쿠키) ---------- */
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const cookieOf = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(x => x[0]));
const isStaff = req => { const c = cookieOf(req).gx_staff; if (!c) return false; const [exp, sig] = c.split('.'); return Number(exp) > Date.now() && sig && safeEq(sig, sign(exp)); };
const staffOnly = (req, res, next) => isStaff(req) ? next() : res.status(401).json({ error: 'unauthorized' });
app.post('/api/staff/login', limit('login', 8, 15 * 60e3), (req, res) => {
  if (!STAFF_PASSWORD || !safeEq(hash(req.body?.password ?? ''), hash(STAFF_PASSWORD))) return res.status(401).json({ error: 'bad_password' });
  const exp = String(Date.now() + 12 * 3600e3);
  res.cookie('gx_staff', `${exp}.${sign(exp)}`, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 12 * 3600e3, path: '/' });
  res.json({ ok: true });
});
app.post('/api/staff/logout', (_req, res) => { res.clearCookie('gx_staff'); res.json({ ok: true }); });
app.get('/api/staff/me', (req, res) => res.json({ authed: isStaff(req), instagram: igConfigured() }));

/* ---------- 설정(가격표) ---------- */
app.get('/api/stats', (_req, res) => res.json({ consults: db.prepare('select count(*) n from cases').get().n }));
app.get('/api/config', (_req, res) => res.json(getCfg()));
app.put('/api/config', staffOnly, (req, res) => {
  const { rate, procs } = req.body || {};
  const old = getCfg();
  if (!(rate > 0 && rate < 1) || !Array.isArray(procs)) return res.status(400).json({ error: 'invalid' });
  const next = { rate, procs: old.procs.map(p => { const n = procs.find(x => x.id === p.id) || p; return { ...p, min: Math.max(0, +n.min || 0), max: Math.max(0, +n.max || 0), stay: Math.max(1, +n.stay || 1) }; }) };
  setCfg(next); res.json(next);
});

/* Public review submissions are stored privately for staff moderation. */
db.exec("create table if not exists patient_reviews(id integer primary key autoincrement, created_at integer not null, nickname text not null, rating integer not null, body text not null, status text not null default 'pending')");
app.post('/api/reviews', limit('review', 3, 3600e3), (req, res) => {
  const b = req.body || {}, nickname = clean(b.nickname, 40), body = clean(b.body, 1000), rating = Number(b.rating);
  if (nickname.length < 2 || body.length < 10 || !Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'invalid_review' });
  db.prepare('insert into patient_reviews(created_at,nickname,rating,body,status) values(?,?,?,?,?)').run(Date.now(), nickname, rating, body, 'pending');
  res.status(201).json({ ok: true, pending: true });
});
app.get('/api/reviews', (_req, res) => res.json(db.prepare("select nickname,rating,body,created_at from patient_reviews where status='approved' order by created_at desc limit 20").all()));
app.get('/api/staff/reviews', staffOnly, (_req, res) => res.json(db.prepare("select * from patient_reviews order by created_at desc limit 100").all()));
app.post('/api/staff/reviews/:id/status', staffOnly, (req, res) => {
  const status = req.body?.status;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const result = db.prepare('update patient_reviews set status=? where id=?').run(status, Number(req.params.id));
  res.json({ ok: result.changes > 0 });
});
/* ---------- 환자 API (case id + secret) ---------- */
const sys = (caseId, at, ja) => messages.add(caseId, { from: 'sys', kind: 'sys', at, ja });
const L = (c, ja, en) => (c.lang === 'en' ? en : ja); // 환자 언어(ja|en)에 맞는 문구
function patientAuth(req, res, next) {
  const row = cases.raw(req.params.id), s = req.get('x-case-secret');
  if (!row || !s || !safeEq(row.secret_hash, hash(s))) return res.status(404).json({ error: 'not_found' });
  req.c = cases.get(req.params.id); next();
}
const SOURCES = ['ig', 'tiktok', 'line', 'x', 'yt', 'direct'];
app.post('/api/cases', limit('newcase', 10, 3600e3), (req, res) => {
  const b = req.body || {}, cfg = getCfg(), now = Date.now();
  const procs = (Array.isArray(b.procs) ? b.procs : []).filter(id => cfg.procs.some(p => p.id === id)).slice(0, 9);
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 3);
  if (!clean(b.name, 60) || !clean(b.contact, 120) || photos.some(p => !validPhoto(p))) return res.status(400).json({ error: 'invalid' });
  const id = crypto.randomBytes(8).toString('hex'), secret = crypto.randomBytes(24).toString('hex');
  const c = { id, createdAt: now, lastAt: now, status: 'new', unreadStaff: true, unreadPatient: false,
    lang: b.lang === 'en' ? 'en' : 'ja', source: SOURCES.includes(b.source) ? b.source : 'direct', ref: clean(b.ref, 40) || null, stage: 'pre', triage: '', meeting: null,
    name: clean(b.name, 60), age: clean(b.age, 20), procs, concerns: clean(b.concerns, 1500), budget: clean(b.budget, 30), visit: clean(b.visit, 30),
    history: clean(b.history, 1500), contact: clean(b.contact, 120), photos, est: estimate(procs, cfg), consentAt: now };
  cases.insert(c, hash(secret));
  const en = c.lang === 'en', names = procs.map(pid => en ? (PROC_EN[pid] || pid) : cfg.procs.find(p => p.id === pid).ja).join(en ? ', ' : '、');
  messages.add(id, { from: 'patient', kind: 'text', at: now, ja: `${en ? '[New inquiry] ' : '【新規相談】'}${names}\n${c.concerns}` });
  sys(id, now + 1, L(c, 'ご相談を受け付けました。スタッフが確認し、24時間以内にこのチャットでお返事します。', 'We have received your inquiry. Our staff will review it and reply in this chat within 24 hours.'));
  res.status(201).json({ id, secret });
});
/* International quick consultation: creates an ordinary case visible in staff inbox. */
app.post('/api/consultations/free', limit('freeconsult', 8, 3600e3), (req, res) => {
  const b = req.body || {}, now = Date.now(), cfg = getCfg();
  const name = clean(b.name, 60), contact = clean(b.contact, 120);
  const country = clean(b.country, 60), channel = clean(b.channel, 30);
  const concerns = clean(b.concerns, 1500);
  const lang = b.lang === 'en' ? 'en' : 'ja';
  if (!name || !contact || !country || !['line','whatsapp','email'].includes(channel) || b.consent !== true)
    return res.status(400).json({ error: 'invalid' });
  const procs = (Array.isArray(b.procs) ? b.procs : []).filter(id => cfg.procs.some(p => p.id === id)).slice(0, 9);
  const id = crypto.randomBytes(8).toString('hex'), secret = crypto.randomBytes(24).toString('hex');
  const c = { id, createdAt: now, lastAt: now, status: 'new', unreadStaff: true, unreadPatient: false,
    lang, source: 'direct', ref: null, stage: 'pre', triage: '', meeting: null, inquiryType: 'free_consultation',
    country, channel, name, age: '', procs, concerns, budget: '', visit: '', history: '',
    contact, photos: [], est: procs.length ? estimate(procs, cfg) : null, consentAt: now };
  cases.insert(c, hash(secret));
  messages.add(id, { from: 'patient', kind: 'text', at: now, ja: '[無料相談 / Free consultation] ' +
    'Country: ' + country + ' / Contact via: ' + channel + '\\n' + (concerns || 'Treatment undecided') });
  sys(id, now + 1, L(c, '無料相談を受け付けました。担当者がこのチャットで返信します。', 'Your free consultation request was received. Our team will reply in this chat.'));
  res.status(201).json({ id, secret });
});
app.get('/api/cases/:id', patientAuth, (req, res) => res.json(req.c));
app.get('/api/cases/:id/messages', patientAuth, (req, res) => res.json(messages.list(req.c.id)));
app.post('/api/cases/:id/lang', patientAuth, (req, res) => { req.c.lang = req.body?.lang === 'en' ? 'en' : 'ja'; cases.save(req.c); res.json({ ok: true }); });
app.post('/api/cases/:id/read', patientAuth, (req, res) => { const c = req.c; if (c.unreadPatient) { c.unreadPatient = false; cases.save(c); } res.json({ ok: true }); });
app.post('/api/cases/:id/messages', patientAuth, limit('pmsg', 60, 3600e3), (req, res) => {
  const c = req.c, now = Date.now(), text = clean(req.body?.text, 2000), photo = req.body?.photo || null;
  if (!text && !photo) return res.status(400).json({ error: 'empty' });
  if (photo && !validPhoto(photo)) return res.status(400).json({ error: 'bad_photo' });
  messages.add(c.id, { from: 'patient', kind: photo ? 'photo' : 'text', at: now, ja: text, photo });
  Object.assign(c, { lastAt: now, unreadStaff: true, status: c.status === 'done' ? 'new' : c.status }); cases.save(c);
  res.json({ ok: true });
});
const SLOT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
app.post('/api/cases/:id/meeting', patientAuth, (req, res) => {
  const c = req.c, now = Date.now(), at = req.body?.at;
  if (at === null) { c.meeting = null; cases.save(c); return res.json({ ok: true }); }
  if (!SLOT.test(at || '') || !Number.isFinite(Date.parse(at + ':00+09:00')) || Date.parse(at + ':00+09:00') < now) return res.status(400).json({ error: 'invalid' });
  c.meeting = { status: 'requested', at }; Object.assign(c, { lastAt: now, unreadStaff: true }); cases.save(c);
  sys(c.id, now, L(c, `ビデオ相談の希望：${at.replace('T', ' ')}（確定までお待ちください）`, `Video consultation requested for ${at.replace('T', ' ')} (please wait for confirmation).`));
  res.json({ ok: true });
});
app.post('/api/cases/:id/aftercare', patientAuth, limit('after', 20, 3600e3), (req, res) => {
  const c = req.c, now = Date.now(), b = req.body || {};
  const syms = (Array.isArray(b.symptoms) ? b.symptoms : []).filter(s => s in SYMPTOM_LEVEL);
  const dayN = clean(b.dayN, 3).replace(/\D/g, ''), photo = b.photo || null;
  if (!dayN || (!photo && !syms.length) || (photo && !validPhoto(photo))) return res.status(400).json({ error: 'invalid' });
  const t = triage(syms);
  messages.add(c.id, { from: 'patient', kind: 'photo', at: now, photo, ja: (c.lang === 'en' ? `[Day ${dayN} after surgery] Symptoms: ${b.symptomNames || (syms.length ? syms.join(', ') : 'none')}` : `【術後${dayN}日目】症状：${b.symptomNames || (syms.length ? syms.join('、') : '特になし')}`).slice(0, 400), aftercare: t });
  Object.assign(c, { stage: 'after', triage: t, triageAt: now, dayN, lastAt: now, unreadStaff: true }); cases.save(c);
  res.json({ triage: t });
});

/* ---------- 직원 API ---------- */
app.get('/api/staff/cases', staffOnly, (_req, res) => res.json(cases.list()));
const staffCase = (req, res, next) => { const c = cases.get(req.params.id); if (!c) return res.status(404).json({ error: 'not_found' }); req.c = c; next(); };
app.get('/api/staff/cases/:id', staffOnly, staffCase, (req, res) => res.json(req.c));
app.get('/api/staff/cases/:id/messages', staffOnly, staffCase, (req, res) => res.json(messages.list(req.c.id)));
app.post('/api/staff/cases/:id/read', staffOnly, staffCase, (req, res) => { req.c.unreadStaff = false; cases.save(req.c); res.json({ ok: true }); });
app.post('/api/staff/cases/:id/status', staffOnly, staffCase, (req, res) => {
  if (!['new', 'replied', 'booked', 'visited', 'lost', 'done'].includes(req.body?.status)) return res.status(400).json({ error: 'invalid' });
  req.c.status = req.body.status; cases.save(req.c); res.json({ ok: true });
});
app.post('/api/staff/cases/:id/messages', staffOnly, staffCase, (req, res) => {
  const c = req.c, now = Date.now(), ja = clean(req.body?.ja, 3000), text = clean(req.body?.text, 3000);
  if (!ja) return res.status(400).json({ error: 'empty' });
  messages.add(c.id, { from: 'staff', kind: 'text', at: now, ja, text: text || ja });
  Object.assign(c, { lastAt: now, unreadPatient: true, status: c.status === 'new' ? 'replied' : c.status }); cases.save(c);
  nudge(c.ref); res.json({ ok: true });
});
const consultationWindow = c => ['confirmed','in_progress'].includes(c.meeting?.status) && Date.now() >= Date.parse(c.meeting.at + ':00+09:00') - 10 * 60e3;
app.post('/api/cases/:id/consultation/start', patientAuth, (req, res) => {
  const c = req.c;
  if (!consultationWindow(c)) return res.status(409).json({ error: 'not_ready' });
  if (c.meeting.status !== 'in_progress') {
    c.meeting.status = 'in_progress'; c.meeting.startedAt = Date.now(); c.lastAt = Date.now(); c.unreadStaff = true;
    cases.save(c); sys(c.id, Date.now(), L(c, '相談が始まりました。チャットでお話しください。', 'Your consultation has started. Please use the chat.'));
  }
  res.json({ ok: true });
});
app.post('/api/staff/cases/:id/consultation/start', staffOnly, staffCase, (req, res) => {
  const c = req.c;
  if (!consultationWindow(c)) return res.status(409).json({ error: 'not_ready' });
  if (c.meeting.status !== 'in_progress') {
    c.meeting.status = 'in_progress'; c.meeting.startedAt = Date.now(); c.lastAt = Date.now(); c.unreadPatient = true;
    cases.save(c); sys(c.id, Date.now(), L(c, '担当者が相談を開始しました。チャットにお進みください。', 'The team has started your consultation. Open the chat.'));
  }
  res.json({ ok: true });
});
app.post('/api/staff/cases/:id/consultation/end', staffOnly, staffCase, (req, res) => {
  const c = req.c;
  if (c.meeting?.status !== 'in_progress') return res.status(409).json({ error: 'not_in_progress' });
  c.meeting.status = 'completed'; c.meeting.endedAt = Date.now(); c.lastAt = Date.now(); c.unreadPatient = true;
  cases.save(c); sys(c.id, Date.now(), L(c, '本日の相談は終了しました。ありがとうございました。', 'This consultation has ended. Thank you.'));
  res.json({ ok: true });
});
app.post('/api/staff/cases/:id/meeting', staffOnly, staffCase, (req, res) => {
  const c = req.c, now = Date.now(), at = clean(req.body?.at, 16), link = clean(req.body?.link, 500);
  if (!SLOT.test(at) || !Number.isFinite(Date.parse(at + ':00+09:00')) || Date.parse(at + ':00+09:00') < now || (link && !/^https:\/\//.test(link))) return res.status(400).json({ error: 'invalid' });
  c.meeting = { status: 'confirmed', at, link }; Object.assign(c, { status: 'booked', lastAt: now, unreadPatient: true }); cases.save(c);
  sys(c.id, now, L(c, `ビデオ相談が確定しました：${at.replace('T', ' ')}（日本時間）。「ビデオ予約」タブから参加できます。`, `Your video consultation is confirmed: ${at.replace('T', ' ')} (Japan/Korea time). Join from the "Video" tab.`));
  nudge(c.ref); res.json({ ok: true });
});
app.post('/api/staff/translate', staffOnly, limit('tr', 120, 3600e3), async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY, text = clean(req.body?.text, 2500), to = ['ko', 'en'].includes(req.body?.to) ? req.body.to : 'ja';
  if (!key) return res.status(501).json({ error: 'no_key' });
  const prompt = to === 'en'
    ? `Translate the following Korean into polite, natural English for a message from a cosmetic clinic to an international patient. Do not add any diagnosis or treatment claims; translate only the meaning. Output only the translation.\n\n${text}`
    : to === 'ja'
    ? `次の韓国語を、美容クリニックから日本人患者へ送る丁寧で自然な日本語(です・ます調)に翻訳してください。診断や治療の断定は加えず、原文の意味だけを訳し、翻訳文のみを出力してください。\n\n${text}`
    : `다음 메시지(미용 클리닉 환자가 보낸 일본어 또는 영어)를 자연스러운 한국어로 번역하세요. 번역문만 출력하세요.\n\n${text}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.TRANSLATE_MODEL || 'claude-sonnet-5-5', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }) });
    if (!r.ok) return res.status(502).json({ error: 'upstream' });
    const j = await r.json(); res.json({ text: (j.content?.[0]?.text || '').trim() });
  } catch { res.status(502).json({ error: 'upstream' }); }
});

/* ---------- Instagram 웹훅 ---------- */
app.get('/webhooks/instagram', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && process.env.IG_VERIFY_TOKEN && req.query['hub.verify_token'] === process.env.IG_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge']));
  res.sendStatus(403);
});
app.post('/webhooks/instagram', async (req, res) => {
  if (!verifySignature(req.rawBody || Buffer.alloc(0), req.get('x-hub-signature-256'), process.env.IG_APP_SECRET)) return res.sendStatus(401);
  res.sendStatus(200); // Meta는 빠른 200 응답을 요구
  handleWebhook(req.body).catch(e => console.error(e));
});

/* ---------- 정적 파일 ---------- */
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(pub, { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.json({ ok: true, instagram: igConfigured() }));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`GALAXY consult on :${port}${PROD ? '' : ` (dev staff password: ${STAFF_PASSWORD})`}`));
}
