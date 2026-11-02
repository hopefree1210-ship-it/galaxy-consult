// 견적·술후 분류 규칙 (서버가 기준값을 계산한다. 클라이언트 값은 신뢰하지 않음)
export const DEFAULT_CFG = {
  rate: 0.105, // 1원 = ○엔. 실제 환율로 수정
  procs: [
    { id: 'maibotsu', ja: '二重（埋没法）', ko: '쌍꺼풀(매몰)', surg: false, min: 50, max: 100, stay: 3 },
    { id: 'sekkai', ja: '二重（切開法）', ko: '쌍꺼풀(절개)', surg: true, min: 150, max: 250, stay: 7 },
    { id: 'megashira', ja: '目頭・目尻切開', ko: '앞/뒤트임', surg: true, min: 150, max: 300, stay: 7 },
    { id: 'hana', ja: '鼻整形', ko: '코 성형', surg: true, min: 300, max: 700, stay: 8 },
    { id: 'rinkaku', ja: '輪郭・小顔', ko: '윤곽', surg: true, min: 800, max: 1500, stay: 12 },
    { id: 'shibo', ja: '顔の脂肪吸引', ko: '안면 지방흡입', surg: true, min: 150, max: 300, stay: 7 },
    { id: 'lift', ja: 'リフトアップ', ko: '리프팅', surg: true, min: 500, max: 1200, stay: 10 },
    { id: 'botox', ja: 'ボトックス・注入', ko: '보톡스/필러', surg: false, min: 20, max: 60, stay: 1 },
    { id: 'laser', ja: '肌・レーザー', ko: '피부/레이저', surg: false, min: 10, max: 50, stay: 1 },
  ],
};
export const SYMPTOM_LEVEL = { fever: 2, bleed: 2, pus: 2, vision: 2, pain: 2, spread: 1, red: 1, asym: 1, bruise: 0, swell: 0 };

export function estimate(ids, cfg) {
  const ps = ids.map(id => cfg.procs.find(p => p.id === id)).filter(Boolean);
  const min = ps.reduce((a, p) => a + Number(p.min), 0), max = ps.reduce((a, p) => a + Number(p.max), 0);
  const jp = v => Math.round((v * 10000 * cfg.rate) / 10000) * 10000;
  return { krwMin: min, krwMax: max, jpyMin: jp(min), jpyMax: jp(max), stay: Math.max(1, ...ps.map(p => Number(p.stay))), surg: ps.some(p => p.surg) };
}
export function triage(symIds) {
  const lv = Math.max(-1, ...symIds.map(id => SYMPTOM_LEVEL[id] ?? -1));
  return lv >= 2 ? 'alert' : lv === 1 ? 'caution' : 'normal';
}

// 영어 시술명 (DB에 저장된 설정에 en이 없어도 동작하도록 id로 매핑)
export const PROC_EN = { maibotsu: 'Double eyelid (suture)', sekkai: 'Double eyelid (incisional)', megashira: 'Epicanthoplasty / lateral canthoplasty', hana: 'Nose surgery',
  rinkaku: 'Facial contouring', shibo: 'Facial liposuction', lift: 'Lifting', botox: 'Botox / fillers', laser: 'Skin / laser' };

/* 상담 가능 일정 기본값(예시). 직원 화면 "상담 일정"에서 병원의 실제 근무 시간으로 수정한다. 시간은 KST=JST. */
const WEEKDAY_TIMES = ['10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
export const DEFAULT_AVAIL = {
  weekly: { 0: [], 1: WEEKDAY_TIMES, 2: WEEKDAY_TIMES, 3: WEEKDAY_TIMES, 4: WEEKDAY_TIMES, 5: WEEKDAY_TIMES, 6: ['10:00', '11:00', '12:00'] },
  closed: [], leadHours: 24, horizonDays: 42,
};

/* 한국 체류 일정 시뮬레이션: 진료 가능 요일(avail.weekly/closed)에 맞춰 검진·시술·경과 확인·최종 확인 날짜를 배치.
   병원의 실제 스케줄 규칙(수술 다음날 소독 등)은 확정 전 추정이며 담당의 확인이 필요하다. */
const ymdAdd = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function simulateStay({ start, stay, surg }, avail) {
  const isOpen = ymd => { if ((avail.closed || []).includes(ymd)) return false; const dow = new Date(ymd + 'T00:00:00Z').getUTCDay(); return (avail.weekly?.[dow] || []).length > 0; };
  const firstOpen = (ymd, lim = 21) => { for (let i = 0; i <= lim; i++) { const d = ymdAdd(ymd, i); if (isOpen(d)) return d; } return null; };
  const ev = [{ date: start, kind: 'arrive' }];
  const exam = firstOpen(start); if (!exam) return null;
  ev.push({ date: exam, kind: surg ? 'exam' : 'treat' });
  let last = exam;
  if (surg) {
    const op = firstOpen(ymdAdd(exam, 1)); if (!op) return null; ev.push({ date: op, kind: 'surgery' }); last = op;
    const chk = firstOpen(ymdAdd(op, 1)); if (chk) { ev.push({ date: chk, kind: 'check' }); last = chk; }
  }
  const target = ymdAdd(start, Math.max(1, stay) - 1);
  if (stay > 2 || surg) { const fin = firstOpen(target > last ? target : ymdAdd(last, last === exam ? 1 : 0)); if (fin && fin > last) { ev.push({ date: fin, kind: 'final' }); last = fin; } }
  ev.sort((a, b) => a.date.localeCompare(b.date));
  const days = Math.round((Date.parse(last) - Date.parse(start)) / 86400e3) + 1;
  return { events: ev, depart: last, days, extended: days > stay };
}
