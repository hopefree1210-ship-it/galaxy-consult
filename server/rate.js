// 실시간 환율(JPY per 1 KRW). 무료 공개 API를 서버에서 1시간 캐시로 조회. 실패하면 직원이 입력한 수동 환율을 사용.
let cache = { rate: null, at: 0, tried: 0 };
const TTL = 3600e3, STALE = 48 * 3600e3;
export async function refreshRate(force = false) {
  const now = Date.now();
  if (!force && cache.rate && now - cache.at < TTL) return cache;
  if (now - cache.tried < 60e3) return cache; // 실패 시 1분 간격 이상으로만 재시도
  cache.tried = now;
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/KRW', { signal: AbortSignal.timeout(6000) });
    const d = await r.json(); const v = Number(d?.rates?.JPY);
    if (d?.result === 'success' && v > 0.01 && v < 1) cache = { rate: v, at: now, tried: now };
  } catch { /* 수동 환율로 대체 */ }
  return cache;
}
export const liveRate = () => (cache.rate && Date.now() - cache.at < STALE ? { rate: cache.rate, at: cache.at } : null);
export const setLiveRateForTest = (rate, at = Date.now()) => { cache = { rate, at, tried: at }; };
