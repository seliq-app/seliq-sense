import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDecide, counterSpecs, decideLimits, LIMITS,
  minuteWindow, dayWindow, secondsToNextMinute, secondsToNextDay,
} from "../src/lib.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const base = () => ({
  device_id: UUID,
  app_version: "0.9.20",
  state: { app: { name: "Mail" }, selection: { text: "hello" } },
  questions: { category: { type: "choice", instructions: "x", criteria: { a: "A", b: "B" } }, need: { type: "score", instructions: "y" } },
});

test("정상 요청 통과, 모델 강제", () => {
  const b = base();
  b.model = "other";
  const r = validateDecide(b);
  assert.equal(r.ok, true);
  assert.equal(r.value.upstream.model, "jev-latest");
  assert.deepEqual(Object.keys(r.value.upstream).sort(), ["model", "questions", "state"]);
});

test("device_id 형식", () => {
  for (const bad of ["abc", "", 5, null, UUID + "x"]) {
    const b = base(); b.device_id = bad;
    assert.equal(validateDecide(b).ok, false);
  }
});

test("질문 6개 초과·0개 거부", () => {
  const b = base();
  b.questions = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`q${i}`, { type: "score" }]));
  assert.equal(validateDecide(b).ok, false);
  b.questions = {};
  assert.equal(validateDecide(b).ok, false);
});

test("허용되지 않은 질문 타입 거부", () => {
  const b = base(); b.questions.need.type = "freeform";
  assert.equal(validateDecide(b).ok, false);
});

test("choice 보기 255개 허용, 256개 거부", () => {
  const mk = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, "d"]));
  const b = base(); b.questions.category.criteria = mk(255);
  assert.equal(validateDecide(b).ok, true);
  b.questions.category.criteria = mk(256);
  assert.equal(validateDecide(b).ok, false);
});

test("문자열 길이 상한", () => {
  const b = base(); b.state.app.name = "x".repeat(2001);
  assert.equal(validateDecide(b).ok, false);
});

test("선택 글 600자로 서버에서도 자름", () => {
  const b = base(); b.state.selection.text = "가".repeat(900);
  const r = validateDecide(b);
  assert.equal(r.ok, true);
  assert.equal(r.value.upstream.state.selection.text.length, 600);
});

test("객체가 아닌 본문 거부", () => {
  assert.equal(validateDecide(null).ok, false);
  assert.equal(validateDecide([]).ok, false);
});

test("창 계산", () => {
  const t = Date.UTC(2026, 9, 4, 12, 30, 15);
  assert.equal(minuteWindow(t), Math.floor(t / 60000));
  assert.equal(dayWindow(t), Math.floor(Date.UTC(2026, 9, 4) / 86400000));
  assert.equal(secondsToNextMinute(t), 45);
  assert.equal(secondsToNextDay(t), 11 * 3600 + 29 * 60 + 45);
  assert.equal(secondsToNextMinute(Date.UTC(2026, 9, 4, 12, 30, 0)), 60);
});

test("제한 판단: 허용/거부/가장 긴 Retry-After", () => {
  const t = Date.UTC(2026, 9, 4, 12, 30, 15);
  const specs = counterSpecs(UUID, "1.2.3.4", t);
  assert.equal(decideLimits(specs, {}).allow, true);

  const dm = specs[0];
  assert.deepEqual(decideLimits(specs, { [dm.key]: LIMITS.deviceMinute }), { allow: false, retryAfter: 45 });
  assert.equal(decideLimits(specs, { [dm.key]: LIMITS.deviceMinute - 1 }).allow, true);

  const g = specs[3];
  const both = decideLimits(specs, { [dm.key]: 30, [g.key]: LIMITS.globalDay });
  assert.equal(both.allow, false);
  assert.equal(both.retryAfter, g.retryAfter);
});

test("상한 값은 설계서 §15와 같다", () => {
  assert.deepEqual(LIMITS, { deviceMinute: 30, deviceDay: 1000, ipMinute: 60, globalDay: 50000 });
});
