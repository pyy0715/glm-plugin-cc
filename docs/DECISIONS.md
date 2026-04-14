# glm-plugin-cc: 설계 결정 기록 및 향후 계획

## 프로젝트 목표

Claude Code에서 GLM(Z.ai)을 효율적으로 함께 사용하기 위한 도구.
- 코드 관련 작업은 GLM에 자동/수동 라우팅
- Claude와 GLM 쿼터를 한눈에 확인
- 같은 세션에서 Claude ↔ GLM 자유 전환

---

## 아키텍처 진화 과정

### Phase 1: 플러그인 스킬 방식 (구현 완료, 한계 발견)

**접근:** Claude Code 플러그인의 스킬(`/glm:task`)이 GLM API를 직접 호출하여 코딩 위임.

**구현물:**
- `skills/task/SKILL.md` — 코딩 작업 위임 (auto-trigger)
- `skills/review/SKILL.md` — 코드 리뷰 위임 (제거됨)
- `skills/setup/SKILL.md` — API 키 확인 (제거됨)
- `scripts/glm-call.js` — GLM API 래퍼 (Anthropic Messages 형식)
- `scripts/statusline.js` — Claude + GLM 쿼터 표시
- `agents/glm-coder.md` — thin forwarding agent (제거됨)

**발견된 한계:**
1. **직렬화 오버헤드** — Claude가 파일을 읽고 JSON으로 직렬화해서 GLM API에 전송. 이중 처리.
2. **GLM 도구 접근 불가** — GLM은 텍스트만 받고 반환. Read/Write/Bash 사용 불가.
3. **원샷 한계** — GLM이 반복 작업(테스트 → 수정 → 재테스트) 불가.
4. **이중 토큰 소모** — Claude 토큰(컨텍스트 수집) + GLM 토큰(코드 생성) 둘 다 사용.
5. **review 제거 이유** — Claude가 이미 컨텍스트에 가진 코드를 GLM에 다시 보내는 건 순수 낭비.
6. **에이전트 제거 이유** — glm-coder는 JSON을 pipe하는 것뿐. 스킬에서 직접 Bash 호출로 충분.

**유지되는 가치:**
- `statusline.js` — 양쪽 쿼터 동시 표시. 대체 불가.
- `task` auto-trigger — 유일하게 "코딩 자동 감지 + GLM 위임"을 하는 방식 (오버헤드 있지만).

### Phase 2: 프록시 방식 (현재, 구현 중)

**접근:** HTTP 프록시가 Claude Code와 API 사이에서 모델명 기반 라우팅.

**핵심 차이:** GLM이 Claude Code의 **네이티브 모델**로 동작 → 파일 접근, 도구 사용, 반복 실행 모두 가능.

**구현물:**
- `src/server.js` — HTTP 서버 (/v1/messages, /_hint, /_status)
- `src/router.js` — 모델명 prefix 기반 라우팅 + hint 지원
- `src/proxy.js` — 업스트림 파이핑, OAuth 토큰 패스스루, SSE pipe()
- `src/config.js` — 환경변수 설정 로드
- `bin/glm-proxy.js` — CLI 진입점

### Phase 3: Hook 자동 라우팅 + 세션 안전성 (2026-04-14 구현)

**구현물:**
- `src/classifier.js` — `glm-4.7` via localhost proxy로 CODE/OTHER 분류 (max_tokens=4, 5s timeout)
- `plugins/glm/hooks/route-hook.js` — UserPromptSubmit 진입점. classify → `/_hint` POST (session_id 포함)
- `plugins/glm/hooks/session-start.js` — SessionStart에서 프록시 살아있는지 체크, 죽어있으면 `spawn + detached + unref`로 기동하고 최대 3초 readiness 폴링
- `plugins/glm/hooks/hooks.json` — hook 등록 (UserPromptSubmit timeout 10s, SessionStart 5s)
- `plugins/glm/skills/setup/SKILL.md` — `/glm:setup`: settings.json의 env에 `ANTHROPIC_BASE_URL`, `GLM_API_KEY`, `GLM_PROXY_PATH` 주입

**동시 세션 교차 오염 해결:** `src/router.js`의 `currentHint` 전역 변수를 `Map<session_id, hint>`로 교체. `body.metadata.user_id`(stringified JSON)에서 `session_id` 추출 후 세션별 힌트 조회. 같은 proxy를 공유하는 다수 Claude Code 세션이 서로 간섭 없이 독립 라우팅.

**Breaking change (내부 API):** `/_hint` 엔드포인트 바디가 `{backend, ttl}` → `{session_id, backend, ttl}`로 변경. `session_id` 누락 시 400. `setHint()` 시그니처도 `(sessionId, backend, ttl)`로 바뀜. 외부 직접 호출자 없으므로 사용자 영향 없음.

---

## 주요 설계 결정

### 1. 프록시 vs 플러그인 스킬

| | 플러그인 스킬 | 프록시 |
|---|---|---|
| GLM 파일 접근 | ❌ 불가 | ✅ 네이티브 |
| 코딩 자동 감지 | ✅ description trigger | ❌ 모델명 기반만 (hook으로 보완 가능) |
| 오버헤드 | 높음 (직렬화) | 없음 |
| 설치 복잡도 | 낮음 (플러그인만) | 중간 (프록시 서버 실행 필요) |

**결론:** 프록시가 근본적으로 우월. hook 자동 분류로 "코딩 자동 감지" 보완 가능.

### 2. Node.js vs Python vs TypeScript

| | Node.js | Python | TypeScript |
|---|---|---|---|
| 의존성 | 0 (내장 http, fetch, pipe) | 최소 3개 (fastapi, uvicorn, httpx) | 빌드 필요 (tsc/tsx) |
| 배포 | npm install -g (Claude Code = Node.js) | Python 미설치 가능 | 어차피 JS로 컴파일 |
| 스트리밍 | pipe() 내장, backpressure 자동 | stdlib 동기 → 별도 프레임워크 필요 | 런타임 동일 |
| 타입 안전성 | `// @ts-check` + JSDoc으로 충분 | 타입 힌트 | 풀 타입 체크 |

**결론:** Node.js + `// @ts-check`. 0 의존성, Claude Code 런타임 보장, 프록시 생태계(http-proxy 등) 전부 plain JS.

### 3. litellm vs 직접 구현

**litellm 사용하지 않는 이유:**
- PyPI 패키지 탈취 사건 (2026-03-24, v1.82.8): credential-stealing 악성 코드 삽입
- 다수 CVE: SSRF, RCE, 인증 우회
- 우리 케이스에서 불필요: Claude와 GLM이 **같은 Anthropic Messages API** 형식 → 포맷 변환 없음

### 4. OAuth 토큰 처리

**문제:** Claude Code Pro/Max 사용자는 OAuth로 인증. 프록시가 중간에 있으면 인증이 깨질 수 있음.

**해결:**
- Claude 라우팅: 원래 Authorization 헤더를 **그대로 보존** (OAuth 토큰 패스스루)
- GLM 라우팅: Authorization 제거, `x-api-key: GLM_API_KEY`로 교체
- `ANTHROPIC_API_KEY` 설정 불필요 → OAuth 충돌 방지

**주의:** 이건 **로컬 프록시**(사용자 본인 자격 증명)라서 ToS 위반이 아님. ohmycode 등 제3자 프록시(자격 증명 공유)와는 근본적으로 다름.

### 5. 라우팅 우선순위

| 순위 | 소스 | 설명 |
|------|------|------|
| 1 | `glm-*` prefix | 사용자가 `/model`에서 explicit하게 GLM을 고른 신호. 항상 GLM. |
| 2 | `claude-haiku-*` prefix | Claude Code 내부 haiku(제목/요약 생성) 호출. 사용자 의도가 아닌 운영용 호출이므로 hint와 무관하게 Claude 고정. GLM 쿼터 낭비 방지. |
| 3 | **세션별** `/_hint` TTL | hook 자동 분류 결과. `body.metadata.user_id`에서 추출한 `session_id` 키로 조회. **세션 간 교차 오염 없음.** `claude-sonnet-*`/`claude-opus-*` 기본 모델을 덮어씀. |
| 4 | `claude-*` prefix | hint 없을 때의 기본 Claude. |
| 5 | `config.defaultBackend` | 최종 폴백. 기본값 "claude". |

**왜 `claude-*` prefix가 hint보다 뒤에 오는가:** Claude Code가 기본으로 `claude-sonnet-4-6` / `claude-opus-4-6`를 요청에 실어보내기 때문에, 만약 prefix 우선이면 hook의 CODE 판정이 **항상 무시**됨. `claude-*`는 "기본값"이지 "명시 선택"이 아니므로 hint가 덮을 수 있어야 함. 반면 `glm-*`은 사용자가 picker에서 일부러 고른 것이라 explicit로 취급.

### 6. `/model` 피커에 GLM 추가

**문제:** `/model glm-5.1` 입력 시 "Model not found" — Claude Code가 GLM 모델명을 모름.

**해결:** `ANTHROPIC_CUSTOM_MODEL_OPTION` 환경변수:
```json
{
  "env": {
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "glm-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "GLM-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Z.ai GLM-5.1 (routed via glm-proxy)"
  }
}
```
Claude Code가 이 모델 ID의 **검증을 건너뛰므로** 어떤 문자열이든 가능. 단, 한 개만 추가 가능.

### 7. Statusline 쿼터 매핑

Z.ai 공식 플러그인(`zai-org/zai-coding-plugins`)에서 확인:
- `TOKENS_LIMIT` = **5시간 코딩 쿼터** (실제 코딩 사용량)
- `TIME_LIMIT` = **MCP 월간 사용량** (Vision/Search/Reader)

초기에 반대로 매핑했다가 수정함.

---

## 검증 결과

### Hook 통신 검증 (2026-04-13)

| 항목 | 결과 |
|------|------|
| `UserPromptSubmit` hook 실행 타이밍 | ✅ API 호출 **전에** blocking으로 실행 |
| 사용자 메시지 접근 | ✅ stdin JSON의 `prompt` 필드 (문서의 `user_prompt`가 아님!) |
| `systemMessage` 주입 | ✅ Claude 컨텍스트에 반영됨 |
| hook에서 `curl localhost` | ✅ 동작 확인 |
| hook끼리 출력 공유 | ❌ **불가** — 각 hook 독립 실행 |

### 프록시 동작 검증 (2026-04-13)

| 항목 | 결과 |
|------|------|
| `glm-5.1` → GLM 라우팅 | ✅ `api.z.ai`로 전달, 응답 수신 |
| `claude-opus-4-6` → Claude 라우팅 | ✅ `api.anthropic.com`으로 전달 |
| OAuth 토큰 패스스루 | ✅ Claude 라우팅 시 원래 인증 유지 |
| SSE 스트리밍 | ✅ pipe()로 패스스루 |
| `/_hint` 엔드포인트 | ✅ 힌트 저장/조회 동작 |
| `/model glm-5.1` 전환 | ✅ `ANTHROPIC_CUSTOM_MODEL_OPTION` 설정 후 동작 |
| Claude Code 통합 | ✅ GLM이 네이티브로 응답 |

### GLM API 검증 (2026-04-02)

| 항목 | 결과 |
|------|------|
| `api/paas/v4` 엔드포인트 | ❌ 429 — Coding Plan 미지원, 별도 충전 필요 |
| `api/anthropic/v1/messages` 엔드포인트 | ✅ Coding Plan 쿼터 사용 |
| 기본 모델 `glm-4-plus` | ❌ 존재하지 않음 |
| `glm-5.1` | ✅ 동작 확인 |
| Auth `Authorization: <key>` | ❌ Anthropic 형식이 아님 |
| Auth `x-api-key: <key>` | ✅ Anthropic 형식 |
| 쿼터 API auth | ✅ Authorization, x-api-key, Bearer 모두 수용 |

---

## 참고한 프로젝트/자료

### 참조 구현체
- **openai/codex-plugin-cc** — Claude Code에서 Codex 사용. 로컬 CLI(`@openai/codex`)를 감싸는 구조. 우리와 근본적으로 다름 (GLM에 로컬 CLI 없음).
- **yangtau/claude-agents-plugins** — Cursor Agent CLI를 감싸는 동일 패턴.
- **starbaser/ccproxy** — LiteLLM 기반 프록시. 규칙 기반 라우팅 (모델명, thinking, 토큰수, 도구). Hook + Proxy 아키텍처의 영감원.
- **1rgs/claude-code-proxy** — 단순 프록시 (litellm 사용).
- **fuergaosi233/claude-code-proxy** — litellm 없이 직접 변환 구현.

### AI 게이트웨이
- **Portkey-AI/gateway** — metadata 기반 conditional routing. "코딩 감지" 불가.
- **alibaba/higress** — URL/헤더 기반 프록시 라우팅.
- **결론:** AI 게이트웨이는 전부 메타데이터/구조 기반 라우팅. 요청 내용으로 "코딩 여부" 판단하는 게이트웨이는 없음.

### 공식 문서
- Z.ai Coding Plan FAQ: `https://docs.z.ai/devpack/faq`
- Z.ai Claude Code 설정: `https://docs.z.ai/devpack/tool/claude`
- Z.ai GLM-5.1 사용법: `https://docs.z.ai/devpack/using5.1`
- Z.ai Best Practice: `https://docs.z.ai/devpack/resources/best-practice`
- GLM OpenAPI 스펙: `https://docs.bigmodel.cn/openapi/openapi.json`
- Claude Code Hooks: `https://code.claude.com/docs/ko/hooks`
- Claude Code Model Config: `https://code.claude.com/docs/en/model-config`
- Anthropic SDK (TypeScript): `https://github.com/anthropics/anthropic-sdk-typescript`

### 보안 이슈
- **litellm PyPI 탈취 (2026-03-24)**: v1.82.8에 credential-stealing 악성 코드. SSH 키, AWS 자격증명, Docker 설정 탈취. Python 실행만으로 발동.
- **litellm CVE-2026-24486, CVE-2025-67221**: 미수정.
- **litellm SSRF + RCE**: api_base 파라미터 + guardrail 샌드박스 누락.

---

## 향후 할 일 (TODO)

### Phase 2 잔여 — 프록시 안정화
- [x] ~~프록시 데몬 모드 (`--detach`)~~ → SessionStart hook이 자동 기동 (2026-04-14 구현)
- [x] 기존 플러그인 스킬 코드 정리 (완료: 34e19bf)
- [ ] 프록시 다운 시 graceful fallback (현재는 ECONNREFUSED → Claude Code 에러)
- [ ] README 프록시 방식으로 전면 개편
- [ ] 모델 전환 지연 (~20초) 원인 조사 — `claude-haiku` 내부 호출이 관련?

### Phase 3 — Hook 자동 라우팅 (2026-04-14 완료)
- [x] `src/classifier.js` — `glm-4.7` via localhost proxy로 CODE/OTHER 판단
- [x] `plugins/glm/hooks/route-hook.js` — UserPromptSubmit 진입점
- [x] `plugins/glm/hooks/session-start.js` — 프록시 자동 기동 + readiness 폴링
- [x] `plugins/glm/hooks/hooks.json` — hook 등록
- [x] `plugins/glm/skills/setup/SKILL.md` — `/glm:setup`
- [x] `/reload-plugins`가 env var 재적용하는지 실증 검증 — Claude Code가 `ANTHROPIC_BASE_URL`을 **자동으로** 러닝 세션에 재적용함 (`/reload-plugins` 없이도). LEARNINGS.md 2.2 참조.
- [ ] 분류 정확도 테스트 + 프롬프트 튜닝 (실사용 피드백 기반)
- [ ] 지연 측정 (hook 전체 ~500ms 허용 범위 확인)

### Phase 4 — 추가 기능 (검토 중)
- [ ] `ANTHROPIC_CUSTOM_MODEL_OPTION`으로 GLM 모델 여러 개 추가 가능한지 확인 (현재 1개 제한)
- [ ] 모델 자동 라우팅: GLM-5.1 (복잡), GLM-4.7 (일반) 자동 선택
- [ ] 쿼터 기반 fallback: GLM 쿼터 소진 시 자동 Claude 전환
- [ ] statusline을 프록시에 통합하는 방안 검토

**제거된 항목:**
- ~~launchd plist + systemd user service 템플릿~~ — SessionStart hook이 claude 열 때마다 proxy를 자동 기동하고, proxy는 한 번 뜨면 reboot 전까지 살아있음. Claude Code 외 용도로 proxy를 쓸 일이 없어 별도 daemon 관리 불필요하다고 판단.

---

## 현재 파일 구조

```
glm-plugin-cc/
├── bin/
│   └── glm-proxy.js               CLI 진입점
├── src/
│   ├── config.js                   설정 로드
│   ├── router.js                   세션별 Map 기반 라우팅
│   ├── proxy.js                    업스트림 파이핑 + OAuth 패스스루
│   └── server.js                   HTTP 서버 (/v1/messages, /_hint, /_status)
├── plugins/glm/                    ← 플러그인 캐시는 이 서브트리만 복사
│   ├── .claude-plugin/
│   │   └── plugin.json             version이 캐시 키. bump해야 새 내용 반영
│   ├── scripts/
│   │   └── statusline.js           쿼터 표시
│   ├── hooks/
│   │   ├── hooks.json              SessionStart + UserPromptSubmit 등록
│   │   ├── session-start.js        프록시 자동 기동 + readiness 폴링
│   │   ├── classifier.js           CODE/OTHER 분류 (glm-4.7 via proxy)
│   │   └── route-hook.js           classify → /_hint POST
│   └── skills/
│       └── setup/SKILL.md          /glm:setup — settings.json 1회 구성
├── .claude-plugin/
│   └── marketplace.json            마켓플레이스 메타
├── test/
│   └── router.test.js              라우팅 규칙 테스트 (12개)
├── tests/
│   └── statusline.test.js
├── docs/
│   └── DECISIONS.md                이 문서
├── package.json
├── .mise.toml                      Node.js 22
├── biome.json                      린팅
├── .gitignore
└── README.md
```

---

## 설정 레퍼런스

### 프록시 실행 (수동 — 개발/디버깅용)
```bash
GLM_API_KEY="..." node ~/Personal/glm-plugin-cc/bin/glm-proxy.js &
```

일반 사용자는 `/glm:setup` 실행 후 SessionStart hook이 자동 기동.

### Claude Code 연결 (`~/.claude/settings.json`)
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "GLM_API_KEY": "...",
    "GLM_PROXY_PATH": "/path/to/bin/glm-proxy.js",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "glm-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "GLM-5.1",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Z.ai GLM-5.1 (routed via glm-proxy)"
  }
}
```

`GLM_PROXY_PATH`는 SessionStart hook이 프록시 기동에 사용. `/glm:setup`이 자동 주입.

### GLM API
- Coding Plan 엔드포인트: `https://api.z.ai/api/anthropic/v1/messages`
- Auth: `x-api-key: <GLM_API_KEY>` (Bearer 아님)
- 쿼터 API: `GET https://api.z.ai/api/monitor/usage/quota/limit`
- 가용 모델: glm-5.1, glm-5, glm-5-turbo, glm-4.7, glm-4.6, glm-4.5, glm-4.5-air
- 쿼터 소모: GLM-5.1/5/5-Turbo 3x(피크)/2x(오프피크), GLM-4.7 1x
