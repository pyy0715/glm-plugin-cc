# glm-plugin-cc: 실증으로 얻은 사실과 주의사항

이 문서는 Phase 2 개발 중 **실험/관찰로 확인된 사실**과 **재현되는 함정**만 기록합니다. 설계 선택의 근거는 `DECISIONS.md`에 있습니다.

날짜: 2026-04-14

---

## 1. Claude Code 플러그인 배포 메커니즘

### 1.1 파일 위치 세 곳

| 경로 | 내용 | 어떻게 갱신되는가 |
|------|------|------------------|
| `~/.claude/plugins/marketplaces/<plugin>/` | **git clone 전체** (리포 루트) | `claude plugin marketplace update <name>` — git pull |
| `~/.claude/plugins/cache/<name>/<plugin>/<version>/` | **`plugins/<name>/` 서브트리만** 복사 | `claude plugin update <plugin>@<marketplace>` — version이 바뀌어야 새 디렉터리 생성 |
| `~/.claude/plugins/installed_plugins.json` | 활성 버전 메타데이터 | 위 두 명령이 자동 업데이트 |

**중요:** cache는 `plugins/<name>/` 서브트리만 가짐. `src/`, `bin/` 같은 리포 루트의 파일은 cache에 **포함되지 않음**. 그래서:
- Hook은 cache 안의 상대경로만 import 가능 (`./classifier.js` OK, `../../src/xxx.js` NG)
- Proxy 실행은 marketplace dir의 절대경로 (`GLM_PROXY_PATH`)로 참조해야 함

### 1.2 캐시 키 = plugin.json의 `version`

`claude plugin update`는 **version 문자열이 바뀌어야 캐시를 새로 만든다**. 같은 version이면 stale 캐시 재활용. 코드 바꿀 때마다 version bump가 강제되는 건 아니지만, 사용자가 `update`해도 반영 안 됨. 확실히 반영시키려면 bump.

캐시는 구버전이 남아도 디스크만 쓸 뿐 문제 없음. 활성 버전은 `installed_plugins.json`의 `installPath`가 결정.

### 1.3 `CLAUDE_PLUGIN_ROOT`

Hook 실행 시 Claude Code가 주입하는 환경변수. **cache 경로**를 가리킨다 (marketplaces가 아님). `hooks.json`에서 `${CLAUDE_PLUGIN_ROOT}/hooks/xxx.js` 식으로 쓴다.

---

## 2. Claude Code API 요청 내부

### 2.1 `body.metadata.user_id`는 stringified JSON

Claude Code는 Anthropic Messages API의 `metadata.user_id` 필드에 **JSON 문자열**을 넣는다:

```json
{
  "metadata": {
    "user_id": "{\"device_id\":\"...\",\"account_uuid\":\"...\",\"session_id\":\"...\"}"
  }
}
```

- 표준 Anthropic 규격이 아닌 Claude Code만의 관례
- 내부 haiku 호출(제목 생성 등)도 같은 session_id를 공유함
- session_id는 세션마다 다른 UUID
- 파싱: `JSON.parse(metadata.user_id).session_id` — 실패할 수 있으니 `try/catch`로 감싸야 함

### 2.2 `ANTHROPIC_BASE_URL`은 실행 중인 세션에 즉시 재적용

settings.json 변경 시 Claude Code가 **자동으로** BASE_URL을 다시 읽고 적용한다. `/reload-plugins` 명령 불필요. 즉:

- `/glm:setup`이 settings.json을 수정하는 순간, 열려있는 **모든** claude 세션이 영향을 받음
- 그 시점에 프록시가 안 떠있으면 → 모든 세션 ECONNREFUSED
- 대응: setup 스킬이 "실행 중 세션 전부 `/exit` + `/resume`" 안내

이는 `docs/DECISIONS.md`의 `/reload-plugins` 미해결 항목에 대한 **실증적 답**이다.

### 2.3 모델 피커 (`ANTHROPIC_CUSTOM_MODEL_OPTION`)

- 현재 **1개만** 등록 가능
- `CUSTOM_MODEL_OPTION_NAME`, `CUSTOM_MODEL_OPTION_DESCRIPTION`도 함께 쓰면 피커 UI 친화적
- 선택하면 요청의 `model` 필드에 그 ID가 그대로 실림
- Claude Code가 **유효성 검증을 스킵**하므로 어떤 문자열이든 통과

### 2.4 `"model": "glm-5.1"` + BASE_URL 없음 = 400 "String should have at most 256 characters"

- settings.json의 기본 `"model"` 값이 Anthropic이 모르는 문자열(`glm-5.1`)인데 `ANTHROPIC_BASE_URL`이 없으면 → `api.anthropic.com`으로 직접 요청 → 거부 → Claude Code의 내부 retry/fallback 경로에서 모델 문자열이 오염되어 >256자가 되는 버그
- 재현 후 원인 불명. Claude Code 내부 이슈로 추정
- 회피: proxy 사용하지 않는 상태에선 `"model": "glm-..."`를 기본값으로 두지 말 것. `/model`로 세션 내에서 선택

### 2.5 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`

- 각 tier에 해당하는 실제 모델 ID
- 내부 호출(제목 생성 등)은 해당 tier의 모델 ID를 사용
- 예: `ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.5-air` 설정 시 내부 haiku도 `glm-4.5-air`로 나감 → 라우팅 prefix 매칭에 영향

---

## 3. UserPromptSubmit Hook

### 3.1 stdin JSON 스키마

실증 확인:

```json
{
  "prompt": "사용자 메시지 원문",
  "session_id": "UUID v4",
  ...
}
```

- `prompt`와 `session_id` 둘 다 **top-level**
- 공식 문서의 `user_prompt` 필드명은 틀린 것으로 확인됨 — 실제는 `prompt`

### 3.2 실행 타이밍

원칙상 **blocking** — API 호출 전에 hook이 exit해야 main prompt이 API로 전송된다.

**그러나 관찰 사실이 혼재:**
- 일반적 관측: classifier가 ~800ms 걸리고 exit, 그 뒤 ~900ms 후에 main prompt이 proxy에 도착 → blocking 정상
- 특정 타이밍(세션 첫 프롬프트?): classifier 요청 14ms 후에 main prompt이 proxy에 도착 → blocking 위반
- **미해결 idiom**: 언제 blocking 위반이 재현되는지 규칙을 아직 모름

Hook은 `process.exit(0)`을 `.finally()`에 두어 반드시 exit하도록 했고, `await fetch(...)`로 classifier 응답을 기다린다. Claude Code 측 hook 구현이 일부 비동기 작업에 대해 무엇을 await하는지가 관건.

### 3.3 Hook에서 전달되지 않는 경우의 env 변수 없음

- Hook은 Claude Code 프로세스의 env를 상속 (proxy도 마찬가지)
- `GLM_HOOK_DEBUG`, `GLM_API_KEY` 등 settings.json의 `env` 블록 값 전부 hook에서 `process.env`로 접근 가능
- 실증: `ps -Ewwp <proxy_pid>`에서 settings의 env 전부 확인됨

---

## 4. 라우팅 우선순위 (현재 확정)

```
1. model.startsWith("claude-haiku-") → Claude  (내부 운영 호출)
2. blocked session ∧ glm-target    → Claude   (§10.5 반응형 학습)
3. model.startsWith("glm-")        → GLM      (사용자 explicit 선택)
4. session hint (from hook)        → hint.backend
5. model.startsWith("claude-")     → Claude   (default)
6. config.defaultBackend           → 최종 fallback
```

**왜 claude-* 가 hint 뒤인가**: Claude Code가 항상 `claude-sonnet-4-6` / `claude-opus-4-6` 같은 기본 모델을 요청에 실어보내기 때문. prefix가 hint보다 먼저면 hook 분류가 **항상 무시**된다. `claude-*`는 "기본값"이지 "명시 선택"이 아니므로 hint가 덮어야 자동 라우팅이 의미가 있다.

**왜 claude-haiku-*는 hint보다 먼저인가**: 내부 제목 생성 같은 Claude Code 자체 호출은 사용자 의도가 아닌 운영 호출. GLM 쿼터를 내부 plumbing에 쓰는 건 낭비. `ANTHROPIC_DEFAULT_HAIKU_MODEL`을 `glm-*`로 바꾼 사용자는 1번 규칙에 걸려 의도대로 GLM으로 감.

실증 (Test A):
- `write a python function ...` → classifier: CODE → hint=glm → opus `claude-opus-4-6` 요청 → `glm`으로 라우팅 ✅
- `프랑스 수도 ...` → classifier: OTHER → hint=claude → opus 요청 → `claude`로 라우팅 ✅
- 동시에 발생한 내부 haiku `claude-haiku-4-6` → 항상 `claude`로 고정 ✅

---

## 5. 세션별 힌트 (Session-keyed)

### 5.1 왜 전역 hint가 버그였나

이전 구현은 `router.js`의 `let currentHint = null` — **모듈 전역 1개**. 두 세션이 같은 proxy를 공유하면 세션 A의 hint가 TTL 동안 세션 B의 요청에도 적용됨.

### 5.2 해결

- `const hints = new Map()` — `session_id → {backend, expires}`
- `extractSessionId(metadata)`가 `metadata.user_id`에서 `session_id` 파싱
- `resolve()`가 세션별 hint 조회

TTL 60s로 같은 세션 내 다중 요청 커버, 다른 세션 간은 키로 격리.

### 5.3 `/_hint` 엔드포인트 스키마 (Breaking Change)

이전: `{backend, ttl?}` → 현재: **`{session_id, backend, ttl?}`**. `session_id` 없으면 400.

---

## 6. Proxy 인프라

### 6.1 자동 기동 (SessionStart hook)

- 포트(`PROXY_PORT=4000`) 체크 → 이미 떠있으면 no-op
- `GLM_PROXY_PATH` 환경변수 없으면 skip (setup 전 graceful degradation)
- `spawn(node, [PROXY_PATH], { detached: true, stdio: ["ignore", logFd, logFd] })`
- 최대 3초 readiness 폴링 후 exit (hook timeout 5초 내)

### 6.2 로그 파일 orphan inode 함정

**재현 사례 (2026-04-14):**
- `rm -f /tmp/glm-proxy.log && touch /tmp/glm-proxy.log` 실행
- Proxy는 이전 inode를 가리키는 fd를 계속 들고 있음 (열린 파일이라 삭제돼도 fd 살아있음)
- Proxy의 stdout은 **삭제된 inode**(새 파일 아님)에 계속 기록 → `cat /tmp/glm-proxy.log`엔 안 찍힘
- `lsof -p <proxy_pid>`에서 fd가 가리키는 inode와 `stat /tmp/glm-proxy.log`의 inode 비교하면 다르게 나옴

**해결:** proxy 재시작 (`pkill -9 -f glm-proxy.js` 후 새 세션 열기)

**예방:** 로그 지울 때 `rm+touch` 대신 `truncate -s 0 /tmp/glm-proxy.log` 또는 proxy 재시작

### 6.3 `GLM_PROXY_LOG` 환경변수

기본값 `/tmp/glm-proxy.log`. 다른 경로 원하면 override.

### 6.4 SSE 스트리밍

proxy는 `upstreamRes.pipe(clientRes)`로 바디 스트리밍. 별도 처리 없이 SSE pass-through.

### 6.5 인증 헤더 처리

- Claude 라우팅: 요청의 `Authorization` 헤더 원본 유지 (OAuth 토큰 패스스루)
- GLM 라우팅: `Authorization` 제거, `x-api-key: <GLM_API_KEY>` 삽입

---

## 7. Classifier (hook 안)

### 7.1 구현

- `glm-4.7`로 호출 (1x 쿼터, 가장 저렴)
- 프록시 자신의 `/v1/messages`에 요청 → model prefix 규칙으로 자연스럽게 GLM 라우팅
- 별도 인증 불필요 (proxy가 GLM_API_KEY로 재서명)
- System prompt 분리, 프롬프트 앞 2000자로 자름
- 5초 timeout, 실패 시 `null` 반환 → hint 미전송 → default 백엔드 사용

### 7.2 Classifier 재설계 기록 (2026-04-14)

원래 접근은 "software 관련 = CODE"였지만, 두 가지 문제로 두 번 고침.

**1차: few-shot 어휘 편향 (7-shot → 5-shot balanced)**
- 증상: "에러나는데" 같은 단순 불평이 CODE로 오분류 → GLM 라우팅 → context overflow
- 원인: "NullPointerException" CODE 예시가 "에러" 한국어 키워드를 CODE 쪽으로 편향
- 1차 수정: 예시 수 축소 + 어휘 분산 (에러 관련 표현이 CODE/OTHER 양쪽에 등장)

**2차: "production vs. conversation" 재정의 (NVIDIA LLM Router 패턴 참고)**
- 증상: `explain kubectl`, `explain what this regex matches` 같은 교육/설명 질문이 CODE로 분류됨
- 재평가: 사용자 피드백 — kubectl 설명이 왜 GLM으로 가야 하나? Claude가 대화 맥락 유지에 낫다
- **재정의**: CODE는 **코드를 생산/수정**하려는 의도(write/edit/refactor/fix a named artifact)만. 설명/조언/질문은 전부 OTHER (Claude).
- 참고: NVIDIA LLM Router (`github.com/NVIDIA-AI-Blueprints/llm-router`)의 intent-based 패턴 — 카테고리마다 한 줄 설명, one-word 출력
- 결과: 30/30 통과 (verify-classifier.js). "explain what ..." 류는 모두 OTHER로 정분류.

현 구성:
- **영어 전용** system prompt (XML `<task>`/`<definition>`/`<rules>`)
- **6+6 few-shot**: CODE(production/modification/fix), OTHER(explanation/diagnostic question/opinion/chat/general/meta)
- 어휘 분산: "error", "NullPointerException", "kubectl", "git" 모두 양쪽에 등장
- Asymmetric tie-breaker: 불확실하면 OTHER (misrouted OTHER는 무해, misrouted CODE는 context overflow 위험)

### 7.3 검증 자동화

`scripts/verify-classifier.js` — 17 케이스 (이전 오분류 복구 + 회귀 방어) 자동 실행. 50ms 간격 sleep + null 응답에 1회 retry 포함. `npm test`에 포함 X (live API 호출, GLM 쿼터 소모). 새 classifier 변경 시 이 스크립트로 검증.

결과 (2026-04-14 튜닝 3라운드 후): **17/17 pass**.

### 7.4 지연

- Warm: 600-900ms
- Cold: 더 느릴 수 있음 (이전에 관찰된 14ms anomaly의 간접 원인 후보)

### 7.5 비대칭 안전성 원칙

잘못 CODE로 분류 (OTHER→GLM) = GLM context 초과 위험 + 낭비된 GLM 호출 1회 (fallback이 흡수).
잘못 OTHER로 분류 (CODE→Claude) = 기능적 문제 없음 (Claude가 GLM 할 일을 대신 처리).

→ 애매하면 OTHER가 경제적으로 안전. Rules의 tie-breaker에 명시됨.

---

## 8. Dev vs 배포 모드

### 8.1 배포 모드 (정식 배포 경로)

1. dev 리포에서 편집
2. `npm test` + `npx biome check`
3. Commit + push to main
4. 사용자: `claude plugin marketplace update <name> && claude plugin update <plugin>@<marketplace>`
5. claude 재시작
6. 캐시가 stale이면 `plugin.json`의 version bump 필요

**매우 느린 dev cycle** — iteration당 커밋+푸시+update+재시작.

### 8.2 Dev 모드 (심링크)

**Setup (1회):**
```bash
mv ~/.claude/plugins/marketplaces/<name> ~/.claude/plugins/marketplaces/<name>.bak
ln -s <dev_repo_absolute_path> ~/.claude/plugins/marketplaces/<name>
rm -rf ~/.claude/plugins/cache/<name>
mkdir -p ~/.claude/plugins/cache/<name>/<plugin>
ln -s <dev_repo_absolute_path>/plugins/<plugin> ~/.claude/plugins/cache/<name>/<plugin>/<version>
```

**Dev cycle:**
- Hook/skill/classifier 편집: **즉시 반영** (다음 프롬프트에서 새 파일 실행)
- Proxy 코드 편집: proxy 재기동 필요. `node --watch bin/glm-proxy.js`로 자동 재시작 가능
- 커밋/푸시/update 불필요

**⚠️ 주의:**
- `claude plugin marketplace update` 금지 — 심링크 자리에 git clone 받아버림
- `claude plugin update` 금지 — 캐시 심링크 덮어씀
- 배포 전에 **반드시** 원상복구 → 정식 cycle로 테스트

**원상복구:**
```bash
rm ~/.claude/plugins/marketplaces/<name>
rm -rf ~/.claude/plugins/cache/<name>
mv ~/.claude/plugins/marketplaces/<name>.bak ~/.claude/plugins/marketplaces/<name>
claude plugin marketplace update <name>
claude plugin update <plugin>@<marketplace>
```

### 8.3 대안: 직접 캐시 파일 편집

Dev 모드 setup이 번거로울 때, 디버그용으로 `~/.claude/plugins/cache/<name>/<plugin>/<version>/` 파일을 직접 편집해도 됨. 단 다음 `claude plugin update`에서 덮어씌워짐. 테스트 후 dev 리포에 반영 필요.

---

## 9. 디버깅 환경변수

| 변수 | 효과 |
|------|------|
| `GLM_DEBUG=1` | proxy가 요청마다 `body.metadata`와 `system` 요약을 stdout에 출력 |
| `GLM_HOOK_DEBUG=1` | route-hook.js가 `/tmp/glm-route-hook.log`에 phase별 타이밍 기록 |
| `GLM_PROXY_LOG` | SessionStart hook이 proxy stdout/stderr를 리다이렉트할 파일. 기본 `/tmp/glm-proxy.log` |
| `GLM_PROXY_URL` | hook이 proxy를 찾는 URL. 기본 `http://localhost:4000` |
| `GLM_CLASSIFY_TIMEOUT_MS` | classifier fetch timeout. 기본 5000 |
| `GLM_HINT_TTL_MS` | hook이 hint에 붙이는 TTL. 기본 60000 |
| `GLM_PROXY_READY_TIMEOUT_MS` | SessionStart hook의 포트 readiness 폴링 제한. 기본 3000 |
| `GLM_BLOCK_TTL_MS` | Context overflow 맞은 세션을 GLM 라우팅에서 제외하는 TTL. 기본 600000 (10분). §10.5 |

---

## 10. 관측된 이슈 기록 (대부분 해결됨)

### 10.1 Turn-1 blocking anomaly (더 이상 재현 안 됨)

**과거 관측 (2026-04-14 초반):** 한 세션의 첫 프롬프트에서 classifier 요청과 main opus 요청 간격이 14ms로 관측된 적 있음. Classifier(평균 700–900ms)가 반환했을 리 없는 간격이라 hook이 blocking되지 않은 것으로 보였음. Turn 2에서는 ~900ms로 정상 blocking.

**이후 관측 (thinking strip + cache 클린 이후):** Turn 1 / Turn 2 모두 일관되게 1–3초 간격으로 정상 blocking. 14ms anomaly 재현 안 됨.

**가장 유력한 원인 추정:** 당시 `installed_plugins.json`에 활성 버전은 `0.1.0`이었고 캐시 디렉터리엔 `0.1.0`, `0.2.0`, `0.2.1`이 뒤섞여 있었음. Claude Code가 로드한 hook이 **의도한 버전이 아니었을 가능성이 매우 높음**. 옛 버전 hook이 `await fetch(...)`를 제대로 기다리지 않았거나, 다른 async 이슈가 있었을 수 있음. 캐시 정리(`rm -rf ~/.claude/plugins/cache/glm-plugin-cc`) + plugin.json version bump로 `installed_plugins.json`이 0.2.3을 가리키게 정상화된 이후 재발 없음.

**교훈:** Hook/skill 디버깅 시 **가장 먼저 확인**할 것:
```bash
cat ~/.claude/plugins/installed_plugins.json | python3 -c "import json,sys; p=json.load(sys.stdin)['plugins']['glm@glm-plugin-cc']; print(p[0]['installPath'], p[0]['version'])"
ls ~/.claude/plugins/cache/glm-plugin-cc/glm/
```
활성 `installPath` 아래의 hook 파일이 실제 읽히는 것임. 캐시 디렉터리에 다른 버전이 있다고 해서 그게 활성은 아님.

### 10.2 Thinking block signature mismatch (해결됨)

```
API Error: 400
messages.1.content.0: Invalid `signature` in `thinking` block
```

**증상:** 같은 세션에서 한 백엔드(예: Claude)가 반환한 thinking block이 대화 이력에 남은 채로 다음 턴이 다른 백엔드(GLM)로 라우팅되면, 새 백엔드가 상대 서명을 검증할 수 없어 400.

**해결:** Proxy가 **모든 outbound 요청의 assistant 메시지에서 `thinking`과 `redacted_thinking` content block을 스트립**. 각 백엔드가 깨끗한 이력만 받으므로 서명 충돌 없음. 현재 턴의 thinking은 요청의 `thinking` 필드로 새로 생성되므로 기능 손실 없음.

- 구현: `src/sanitize.js`의 `stripAssistantThinking(body)` 순수 함수
- 적용 위치: `src/server.js`에서 forward 직전
- 테스트: `test/sanitize.test.js` (9 케이스)
- `GLM_DEBUG=1`이면 스트립 발생 시 `stripped thinking blocks from assistant history` 로그

### 10.3 Z.ai의 context overflow 표기 방식 (해결됨)

**발견 (2026-04-14)**: Z.ai Anthropic-compatible 엔드포인트는 context window 초과를 **400 `invalid_request_error`로 주지 않음**. 대신:

- **Non-streaming**: `status=200` + body `{"content":[], "stop_reason":"model_context_window_exceeded","usage":{"input_tokens":0,"output_tokens":0}}`
- **Streaming (SSE)**: `message_start` → `message_delta` (`delta.stop_reason=model_context_window_exceeded`) → `message_stop`. content_block_start 이벤트가 **없음** (모델이 응답 생성을 시작도 안 함).

Claude Code가 사용자에게 보여주는 "The model has reached its context window limit" 에러는 클라이언트가 이 stop_reason을 보고 생성한 메시지.

**해결**: proxy에 양방향 fallback 추가 (`src/fallback.js` + `src/server.js`의 `tryGlmNonStreaming` / `tryGlmStreaming`).

- Non-streaming: upstream body 전체 버퍼링(1MB 상한) → `isContextLimitByStopReason` → true면 Claude fallback
- Streaming: upstream SSE를 64KB까지 버퍼링하며 `createSseDetector()`로 초기 이벤트 스캔 → `context_exceeded` 판정 시 버퍼 폐기 + Claude 재요청, `normal` 판정 시 버퍼 flush + pipe
- Fallback 전 body.model을 원본 inbound로 복원 (rewrite된 `glm-5.1`을 Claude가 거부 안 하게)
- 400 경로는 여전히 이중 안전망으로 유지 (Anthropic 직접 요청 대비)

로그: `[ctx-fallback] <inboundModel> -> claude (glm 200 stop_reason: model_context_window_exceeded)`

### 10.4 `/reload-plugins` 단독 효과

BASE_URL 재적용이 `/reload-plugins` 없이도 일어나는 건 실증함. `/reload-plugins`가 **추가로** 어떤 env를 재읽는지는 미검증.

### 10.5 1M opt-in 세션의 GLM 반복 overflow (해결됨, 2026-04-15)

**발견:** `/model claude-opus-4-6[1m]` 사용 시 Claude Code가 claw-code `src/utils/context.ts`의 `has1mContext = /\[1m\]/i.test(model)` 패턴을 통해 컨텍스트 윈도우를 1M으로 인식하고 autoCompact 임계값을 ~987K로 올림. 누적 컨텍스트가 GLM 200K 한도를 크게 넘은 상태에서 hook이 CODE 분류하면 Z.ai가 `200 OK + stop_reason=model_context_window_exceeded`(§10.3) 반환 → fallback이 Claude로 재호출. 컨텍스트는 단조 증가라 같은 세션 다음 턴도 재거부 거의 확실, 그런데도 매 턴 시도 → quota/지연 낭비.

**해결:** "반응형 세션 학습"
- `src/router.js`에 `blockedSessions: Map<sessionId, expiresAt>` 추가 (`hints` Map과 동일 GC 패턴)
- `src/server.js`의 기존 3개 overflow 감지 분기(400/200/SSE)에서 fallback 직전 `markSessionBlocked(sid)` 호출
- `resolve()`가 hint 조회 전에 block 체크 — block 활성 + GLM 타겟(explicit glm-* 또는 hint=glm)이면 Claude 우회
- TTL `GLM_BLOCK_TTL_MS` 기본 10분 → `/clear`/`/compact` 후 자동 재시도

**절감:** 세션당 첫 overflow 1회는 불가피하나, 이후 반복 GLM 헛 호출 제거. 하드코드 임계값·언어 분기 없음.

로그: `[session-block] sid=<8char> ttl=600000ms` (fallback 라인 직후에 출력)

---

## 11. 요약: 한 장짜리 체크리스트

**신규 기능/버그 디버깅할 때 확인 순서:**

1. 캐시 버전 확인: `ls ~/.claude/plugins/cache/<name>/<plugin>/`
2. 활성 버전 확인: `cat ~/.claude/plugins/installed_plugins.json`
3. Proxy 살아있나: `lsof -ti:4000` + `curl -s http://localhost:4000/_status`
4. Proxy 로그 고아 inode?: `stat /tmp/glm-proxy.log`의 inode vs `lsof -p <pid>`의 fd 비교
5. Hook 실제 실행됐나: `GLM_HOOK_DEBUG=1`로 marker/timing 확인
6. 분류 정상?: `/tmp/glm-route-hook.log`의 `classify-done result=` 확인
7. Hint 전송 성공?: `hint-post-done status=200` 확인
8. 라우팅 결과?: `/tmp/glm-proxy.log`의 `model -> backend` 라인
9. session_id 일치?: hook log의 session_id와 proxy log의 metadata 비교

**로그 리셋할 때:**
- `rm+touch` 대신 `truncate -s 0 /tmp/glm-proxy.log`
- 또는 proxy 재시작 (`pkill -9 -f glm-proxy.js`, SessionStart hook이 자동 respawn)
