// 통합 테스트: node server/test.js (메모리 DB, 외부 호출 없음)
process.env.DB_FILE = ':memory:'; process.env.STAFF_PASSWORD = 'pw-test'; process.env.IG_APP_SECRET = 'appsecret'; process.env.IG_VERIFY_TOKEN = 'vt';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const { app } = await import('./index.js');
const { verifySignature, handleWebhook, welcomeText } = await import('./instagram.js');
const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
const j = async (p, o = {}) => { const r = await fetch(base + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); return { s: r.status, b: await r.json().catch(() => null), h: r.headers }; };
let n = 0; const ok = (name, f) => f().then(() => console.log('✓', name), e => { console.error('✗', name, e.message); process.exitCode = 1; });

await ok('환자 접수 → 견적 서버계산, 잘못된 입력 거부', async () => {
  assert.equal((await j('/api/cases', { method: 'POST', body: { name: 'a' } })).s, 400);
  const r = await j('/api/cases', { method: 'POST', body: { name: 'Yuki', contact: 'l', age: '20代', procs: ['sekkai', 'hana', 'bogus'], concerns: 'x', budget: 'b', visit: 'v' } });
  assert.equal(r.s, 201); globalThis.C = r.b;
  const c = await j('/api/cases/' + r.b.id, { headers: { 'x-case-secret': r.b.secret } });
  assert.equal(c.b.est.krwMin, 450); assert.equal(c.b.procs.length, 2);
  assert.equal((await j('/api/cases/' + r.b.id, { headers: { 'x-case-secret': 'nope' } })).s, 404);
});
await ok('직원 API는 로그인 필요, 로그인 후 목록 조회', async () => {
  assert.equal((await j('/api/staff/cases')).s, 401);
  assert.equal((await j('/api/staff/login', { method: 'POST', body: { password: 'bad' } })).s, 401);
  const l = await j('/api/staff/login', { method: 'POST', body: { password: 'pw-test' } });
  globalThis.ck = l.h.get('set-cookie').split(';')[0];
  const ls = await j('/api/staff/cases', { headers: { cookie: ck } });
  assert.equal(ls.b.length, 1); assert.equal(ls.b[0].photos, undefined);
});
await ok('직원 답변·화상 확정이 환자에게 전달', async () => {
  const H = { cookie: ck }, id = C.id, S = { 'x-case-secret': C.secret };
  await j(`/api/staff/cases/${id}/messages`, { method: 'POST', headers: H, body: { ja: 'こんにちは', text: '안녕하세요' } });
  assert.equal((await j(`/api/staff/cases/${id}/meeting`, { method: 'POST', headers: H, body: { at: '2026-11-03T15:00', link: 'http://evil' } })).s, 400);
  assert.equal((await j(`/api/staff/cases/${id}/meeting`, { method: 'POST', headers: H, body: { at: '2026-11-03T15:00', link: 'https://zoom.us/j/1' } })).s, 200);
  const c = await j('/api/cases/' + id, { headers: S }), m = await j(`/api/cases/${id}/messages`, { headers: S });
  assert.equal(c.b.meeting.status, 'confirmed'); assert.equal(c.b.unreadPatient, true); assert.ok(m.b.some(x => x.ja === 'こんにちは'));
});
await ok('술후 증상 분류: 발열=긴급, 붓기=정상', async () => {
  const S = { 'x-case-secret': C.secret };
  assert.equal((await j(`/api/cases/${C.id}/aftercare`, { method: 'POST', headers: S, body: { dayN: '3', symptoms: ['fever'] } })).b.triage, 'alert');
  assert.equal((await j(`/api/cases/${C.id}/aftercare`, { method: 'POST', headers: S, body: { dayN: '3', symptoms: ['swell'] } })).b.triage, 'normal');
});
await ok('인스타 웹훅: 서명 검증·검증 토큰·자동응답 24시간 1회', async () => {
  const body = JSON.stringify({ entry: [{ messaging: [{ sender: { id: 'u1' }, message: { text: '相談' } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(body).digest('hex');
  assert.ok(verifySignature(Buffer.from(body), sig, 'appsecret')); assert.ok(!verifySignature(Buffer.from(body + ' '), sig, 'appsecret'));
  assert.equal((await fetch(base + '/webhooks/instagram', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401);
  assert.equal((await fetch(base + '/webhooks/instagram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body })).status, 200);
  const g = await fetch(base + '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=123'); assert.equal(await g.text(), '123');
  assert.equal((await fetch(base + '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status, 403);
  process.env.BASE_URL = 'https://x.example'; const sent = [];
  const send = async (id, t) => sent.push([id, t]);
  const ev = { entry: [{ messaging: [{ sender: { id: 'u2' }, message: { text: 'hi' } }, { sender: { id: 'u2' }, message: { text: 'again' } }, { sender: { id: 'u3' }, message: { is_echo: true, text: 'me' } }] }] };
  await handleWebhook(ev, send); assert.equal(sent.length, 1); assert.match(sent[0][1], /src=ig&ref=u2/);
});
await ok('영어 환자: 영어 안내문·영어 시술명, 언어 변경', async () => {
  const r = await j('/api/cases', { method: 'POST', body: { name: 'Anna', contact: 'a@x.com', age: '20代', procs: ['hana'], concerns: 'natural look', budget: 'b', visit: 'v', lang: 'en' } });
  const S = { 'x-case-secret': r.b.secret }, m = await j(`/api/cases/${r.b.id}/messages`, { headers: S });
  assert.match(m.b[0].ja, /^\[New inquiry\] Nose surgery/); assert.match(m.b[1].ja, /We have received/);
  assert.equal((await j(`/api/cases/${r.b.id}/lang`, { method: 'POST', headers: S, body: { lang: 'ja' } })).s, 200);
  assert.equal((await j('/api/cases/' + r.b.id, { headers: S })).b.lang, 'ja');
});
srv.close();
