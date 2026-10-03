// Seliq 센스 중계 Worker — 앱에는 TypeSafe 키를 두지 않고, 이 Worker만 키(Secret)를 가진다.
// 본문은 저장·로그하지 않는다(카운터만 센다).
import { DurableObject } from "cloudflare:workers";
import { MAX_BODY_BYTES, counterSpecs, decideLimits, validateDecide, dayWindow } from "./lib.js";

const UPSTREAM = "https://api.typesafe.ai/v1/systemone";
const UPSTREAM_TIMEOUT_MS = 3000;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
    if (url.pathname !== "/v1/decide" || request.method !== "POST") return json({ error: "not_found" }, 404);
    return decide(request, env);
  },
};

async function decide(request, env) {
  if (!env.TYPESAFE_API_KEY) return json({ error: "server_misconfigured" }, 500);

  // 본문 크기 제한(≤32KB) — 선언된 길이와 실제 읽은 길이 모두 확인
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return json({ error: "bad_request" }, 400);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return json({ error: "bad_request" }, 400);

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const v = validateDecide(body);
  if (!v.ok) return json({ error: "bad_request" }, 400);

  // 제한 확인 — 허용이면 DO가 같은 호출 안에서 카운터를 올린다(원자적)
  // IP는 그대로 저장하지 않는다 — 하루 단위 소금을 섞은 SHA-256 앞 16자로만 센다(그날 카운터에만 쓰이고 다음 날 지워짐)
  const rawIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const salt = `${env.IP_SALT || "seliq-sense"}:${Math.floor(Date.now() / 86_400_000)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${rawIp}`));
  const ip = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  // 지연을 줄이려고 한도 확인과 Jev 호출을 동시에 시작한다. 한도에 걸리면 Jev 결과는 버리고 429.
  // (한도에 걸린 요청도 Jev 한 번은 쓰일 수 있다 — 요청당 ≈$0.00004라 감수)
  const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
  const verdictP = stub.check(v.value.device_id, ip, Date.now());
  const upstreamP = fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
    body: JSON.stringify(v.value.upstream),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch(() => null);
  const verdict = await verdictP;
  if (!verdict.allow) {
    return json({ error: "rate_limited" }, 429, { "Retry-After": String(verdict.retryAfter) });
  }
  const res = await upstreamP;
  if (!res) return json({ error: "upstream" }, 502);
  // 원인 파악용으로 TypeSafe 응답 코드만 알려 준다(401 = 키 문제, 429 = TypeSafe 한도, 4xx = 요청 형식). 본문·키는 담지 않는다.
  if (!res.ok) return json({ error: "upstream", upstream_status: res.status }, 502);

  let data;
  try {
    data = await res.json();
  } catch {
    return json({ error: "upstream" }, 502);
  }
  if (!data || typeof data.answers !== "object" || data.answers === null) return json({ error: "upstream" }, 502);

  const inputTokens = Number(data.usage?.input_tokens);
  return json({ answers: data.answers, usage: { input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0 } });
}

// 기기·IP·전체 카운터를 한 곳에서 원자적으로 처리 (DO는 요청을 직렬 처리)
export class Limiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL, day INTEGER NOT NULL)");
  }

  check(deviceId, ip, nowMs) {
    const day = dayWindow(nowMs);
    // 지난 날 카운터 정리(오늘 것만 유지, 분 창도 하루 안에 포함)
    this.sql.exec("DELETE FROM counters WHERE day < ?", day);

    const specs = counterSpecs(deviceId, ip, nowMs);
    const counts = {};
    for (const s of specs) {
      const row = this.sql.exec("SELECT n FROM counters WHERE key = ?", s.key).toArray()[0];
      counts[s.key] = row ? row.n : 0;
    }
    const verdict = decideLimits(specs, counts);
    if (!verdict.allow) return verdict;

    for (const s of specs) {
      this.sql.exec(
        "INSERT INTO counters (key, n, day) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = n + 1",
        s.key,
        day,
      );
    }
    return verdict;
  }
}
