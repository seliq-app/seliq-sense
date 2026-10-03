# seliq-sense

Seliq 센스(AI 모드)용 중계 서버. Cloudflare Worker 하나로, 앱이 보낸 "지금 상황"을 TypeSafe Jev에 전달하고 판단 결과만 돌려준다. 앱에는 TypeSafe 키가 없고, 키는 이 Worker의 Secret에만 있다.

## 하는 일
- `POST /v1/decide` — 검증 → 제한 확인 → `https://api.typesafe.ai/v1/systemone` 전달(모델은 서버가 `jev-latest`로 고정, 제한시간 3초).
- `GET /health` → `{"ok":true}`. 그 외 경로는 404. CORS 없음(앱 전용).
- 요청 본문은 저장·로그하지 않는다. 카운터(기기·IP·전체)만 Durable Object(SQLite)에 센다.

## 계약
요청(본문 ≤ 32KB):
```json
{ "device_id": "<uuid>", "app_version": "0.9.20", "state": { }, "questions": { } }
```
- `device_id`: UUID 형식. `questions`: 1~6개, 타입은 `choice` / `score` / `noul`만, choice 보기 ≤ 255개.
- 문자열은 길이 상한 검사, `state.selection.text`는 600자에서 서버가 한 번 더 자른다.

응답: `{ "answers": { }, "usage": { "input_tokens": 123 } }`

| 상태 | 본문 | 뜻 |
|---|---|---|
| 400 | `{"error":"bad_request"}` | 형식·크기·타입 검증 실패 |
| 429 | `{"error":"rate_limited"}` + `Retry-After`(초) | 상한 초과 |
| 502 | `{"error":"upstream"}` | TypeSafe 오류·시간 초과 |
| 500 | `{"error":"server_misconfigured"}` | `TYPESAFE_API_KEY` 미설정 |

## 상한 (UTC 창)
| 대상 | 분당 | 하루 |
|---|---|---|
| 기기(`device_id`) | 30 | 1,000 |
| IP(`CF-Connecting-IP`) | 60 | - |
| 서버 전체 | - | 50,000 |

Durable Object 하나(`Limiter`)가 네 카운터를 한 번에 확인하고, 모두 여유가 있을 때만 함께 올린다(원자적). 넘으면 429.

## 테스트
```sh
node --test test/validate.test.mjs   # 또는 npm test (설치 불필요)
```

## Cloudflare 설정
1. 대시보드 > Workers & Pages > `seliq-sense` > Settings > Variables and Secrets > Add > 종류 **Secret**, 이름 `TYPESAFE_API_KEY`, 값에 키 입력 > Deploy.
2. 저장소 연결(Workers Builds): Workers & Pages > Create > Import a repository(Git) > GitHub 연결 후 `seliq-app/seliq-sense` 선택 > 프로젝트 이름 `seliq-sense`(wrangler.toml의 name과 같아야 함) > 배포 명령 기본값(`npx wrangler deploy`) > 저장. 이후 main 푸시마다 자동 배포.
3. 확인: `https://seliq-sense.<계정>.workers.dev/health` 가 `{"ok":true}`.

키는 코드·`wrangler.toml`·`.dev.vars`를 커밋하지 않는다(`.gitignore`에 포함). 로컬 시험은 `.dev.vars`에 `TYPESAFE_API_KEY=...`를 두고 `npx wrangler dev`.
