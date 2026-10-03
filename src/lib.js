// 순수 함수 모음 — 검증과 제한 창 계산 (Workers·Node 양쪽에서 동작)

export const LIMITS = {
  deviceMinute: 30,
  deviceDay: 1000,
  ipMinute: 60,
  globalDay: 50000,
};

export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_QUESTIONS = 6;
export const MAX_CRITERIA = 255;
export const MAX_SELECTION_CHARS = 600;
export const MAX_STR = 2000; // 일반 문자열 상한(글자 수)
export const ALLOWED_TYPES = ["choice", "score", "noul"];
export const MODEL = "jev-latest";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// 객체 안의 모든 문자열이 상한 이하인지(중첩 포함, 깊이 제한)
function stringsWithin(v, max, depth = 0) {
  if (depth > 6) return false;
  if (typeof v === "string") return v.length <= max;
  if (Array.isArray(v)) return v.length <= 1000 && v.every((x) => stringsWithin(x, max, depth + 1));
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length > 1000) return false;
    return keys.every((k) => k.length <= max && stringsWithin(v[k], max, depth + 1));
  }
  return true;
}

// 요청 본문 검증. 성공: {ok:true, value:{device_id, upstream}}, 실패: {ok:false, reason}
export function validateDecide(body) {
  if (!isObj(body)) return { ok: false, reason: "body" };
  const { device_id, app_version, state, questions } = body;
  if (typeof device_id !== "string" || !UUID_RE.test(device_id)) return { ok: false, reason: "device_id" };
  if (app_version !== undefined && (typeof app_version !== "string" || !VERSION_RE.test(app_version)))
    return { ok: false, reason: "app_version" };
  if (!isObj(state)) return { ok: false, reason: "state" };
  if (!stringsWithin(state, MAX_STR)) return { ok: false, reason: "state_string" };
  if (!isObj(questions)) return { ok: false, reason: "questions" };

  const names = Object.keys(questions);
  if (names.length < 1 || names.length > MAX_QUESTIONS) return { ok: false, reason: "question_count" };

  const cleanQuestions = {};
  for (const name of names) {
    const q = questions[name];
    if (!KEY_RE.test(name) || !isObj(q)) return { ok: false, reason: "question" };
    if (!ALLOWED_TYPES.includes(q.type)) return { ok: false, reason: "type" };
    if (!stringsWithin(q, MAX_STR)) return { ok: false, reason: "question_string" };
    if (q.type === "choice") {
      const c = q.criteria;
      const n = Array.isArray(c) ? c.length : isObj(c) ? Object.keys(c).length : -1;
      if (n < 1 || n > MAX_CRITERIA) return { ok: false, reason: "criteria" };
    }
    cleanQuestions[name] = q;
  }

  // 선택 글은 서버에서도 600자로 자른다
  const cleanState = structuredCloneJson(state);
  const sel = cleanState.selection;
  if (isObj(sel) && typeof sel.text === "string" && sel.text.length > MAX_SELECTION_CHARS)
    sel.text = sel.text.slice(0, MAX_SELECTION_CHARS);

  return {
    ok: true,
    value: { device_id: device_id.toLowerCase(), upstream: { state: cleanState, model: MODEL, questions: cleanQuestions } },
  };
}

function structuredCloneJson(v) {
  return JSON.parse(JSON.stringify(v));
}

// ---- 제한 창 계산 (UTC 기준) ----
export const minuteWindow = (nowMs) => Math.floor(nowMs / 60000);
export const dayWindow = (nowMs) => Math.floor(nowMs / 86400000);
export const secondsToNextMinute = (nowMs) => Math.max(1, Math.ceil((60000 - (nowMs % 60000)) / 1000));
export const secondsToNextDay = (nowMs) => Math.max(1, Math.ceil((86400000 - (nowMs % 86400000)) / 1000));

// 이번 요청에 쓸 카운터 키와 상한. 항목: {key, limit, retryAfter}
export function counterSpecs(deviceId, ip, nowMs) {
  const m = minuteWindow(nowMs);
  const d = dayWindow(nowMs);
  const rm = secondsToNextMinute(nowMs);
  const rd = secondsToNextDay(nowMs);
  return [
    { key: `dm:${deviceId}:${m}`, limit: LIMITS.deviceMinute, retryAfter: rm },
    { key: `dd:${deviceId}:${d}`, limit: LIMITS.deviceDay, retryAfter: rd },
    { key: `im:${ip}:${m}`, limit: LIMITS.ipMinute, retryAfter: rm },
    { key: `gd:${d}`, limit: LIMITS.globalDay, retryAfter: rd },
  ];
}

// 현재 카운트(counts[key])로 허용 여부 판단. 하나라도 가득이면 deny(가장 긴 retryAfter).
export function decideLimits(specs, counts) {
  let deny = null;
  for (const s of specs) {
    if ((counts[s.key] || 0) >= s.limit && (!deny || s.retryAfter > deny)) deny = s.retryAfter;
  }
  return deny === null ? { allow: true } : { allow: false, retryAfter: deny };
}
