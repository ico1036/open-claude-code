<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.0-blue" alt="version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="node" />
  <img src="https://img.shields.io/badge/Agent%20SDK-0.2.0-purple" alt="agent-sdk" />
  <img src="https://img.shields.io/badge/telegram-tested-blue?logo=telegram" alt="telegram" />
</p>

<p align="center">
  <a href="./README.md">English</a> | <b>한국어</b>
</p>

# OpenClaudeCode

**Claude Code**를 자율적인 멀티 채널 메시징 AI 어시스턴트로 만듭니다. 자기 진화하는 페르소나, 장기 메모리, 그리고 **논블로킹 백그라운드 작업 실행**을 지원합니다.

텔레그램, 왓츠앱, 디스코드를 연결하면 — Claude가 자동으로 응답하고, 대화를 통해 자기만의 성격을 형성하며, 무거운 작업은 서브에이전트에게 위임하고, 세션을 넘어 모든 것을 기억합니다.

> **상태**: 텔레그램은 프로덕션에서 완전히 테스트됨. 왓츠앱과 디스코드 어댑터는 구현되었으나 미테스트.

공식 **Claude Agent SDK** 기반 — Claude Max 구독을 `query()`를 통해 정당하게 사용합니다. API 키 해킹 없음, ToS 위반 없음, 밴 위험 없음.

---

## 주요 특징

- **멀티 채널**: 텔레그램, 왓츠앱, 디스코드를 하나의 게이트웨이로
- **자기 진화 페르소나**: 봇이 스스로 이름을 정하고, 사용자 취향을 파악하고, 성격을 자연스럽게 발전시킴
- **장기 메모리**: FTS5 전문 검색 + 페르소나 파일 + 일별 로그 — 재시작해도 유지
- **백그라운드 작업 스포닝** (v0.2.0): 무거운 작업을 서브에이전트에게 넘기면서 메인 대화는 계속 가능
- **세션 인텔리전스** (v0.3.0): idle timeout, 컴팩션 전 메모리 flush, 인터럽트 명령어
- **멀티 티어 메모리** (v0.3.0): 글로벌 + 채널별 메모리 스코프, 자동 컨텍스트 보존
- **서브에이전트**: translator (Haiku), researcher (Haiku), coder (Sonnet), AGENTS.md로 커스텀 에이전트 추가 가능
- **스킬 시스템**: `~/.openclaudecode/skills/`에 `SKILL.md` 파일을 넣으면 동작 확장
- **제로 설정**: `pnpm install && pnpm build` — Claude에게 봇 토큰 알려주면 끝

---

## v0.2.0의 새로운 기능

### 논블로킹 작업 스포닝 (`spawn_task`)

[OpenClaw](https://github.com/nicholasgriffintn/openclaw)의 `sessions_spawn` 패턴에서 영감. 메인 에이전트가 무거운 작업을 백그라운드 서브에이전트에게 **대화를 차단하지 않고** 위임할 수 있습니다.

```
사용자: "코드베이스 리뷰하고 아키텍처 요약해줘. 그 사이에 우리 다른 얘기하자"
봇:     "코드 리뷰 백그라운드로 돌려놨습니다. 무슨 얘기 하실까요?"

사용자: "점심 뭐 먹지?"
봇:     "라멘 어때요? 🍜"       ← coder가 작업하는 동안 즉시 응답

[30초 후, 자동 announce]
봇:     "[Task completed: coder]
         이 프로젝트는 6개 패키지로 구성되어 있습니다: gateway, adapter-core..."
```

**작동 방식:**
- `spawn_task`가 즉시 `{ status: "accepted", taskId }` 반환
- 서브에이전트는 격리된 세션에서 실행 (자체 컨텍스트, 자체 토큰 예산)
- 완료 시 결과가 자동으로 채팅에 announce
- 메인 에이전트는 응답 가능한 상태 유지 — 작업 중에도 새 메시지 처리
- `task_status` 도구로 언제든 진행 상황 확인 가능

**동시성 제어:**
| 설정 | 기본값 | 설명 |
|------|--------|------|
| `maxChildrenPerSession` | 3 | 대화당 최대 백그라운드 작업 수 |
| `taskTimeoutSeconds` | 300 | 자동 중단 안전장치 |
| `maxConcurrent` | 3 | 전역 동시 세션 제한 (공유) |

**서브에이전트 격리:**
- `spawn_task` 불가 (재귀 스포닝 방지)
- `write_persona` 불가 (봇 성격 변경 불가)
- 메시징, 메모리 검색, 파일 도구는 전체 접근 가능

---

## 빠른 시작

### 사전 요구사항

- **Node.js** 22+
- **pnpm** (`npm install -g pnpm`)
- **Claude Code** CLI 설치 및 로그인 완료
- **텔레그램 봇 토큰** — [@BotFather](https://t.me/BotFather)에서 발급

### 설치

```bash
git clone https://github.com/ico1036/open-claude-code.git
cd open-claude-code
pnpm install
pnpm build
```

### 텔레그램 연결

```bash
# 게이트웨이 데몬 시작
node packages/gateway/dist/gateway-daemon.js
```

다른 터미널에서:

```bash
cd open-claude-code
claude
```

Claude에게:

```
텔레그램 봇 연결해줘, 토큰은 7123456789:AAHxxxxxxx
텔레그램 자동 응답 켜줘
```

봇에게 메시지를 보내면 자동으로 응답합니다.

### 재부팅 시 자동 시작 (macOS)

```bash
pnpm daemon:install
```

### 왓츠앱 / 디스코드

```
# 왓츠앱 — 데몬 로그에서 QR 코드 스캔
왓츠앱 연결

# 디스코드 — Developer Portal에서 봇 토큰 발급 후
디스코드 연결해줘, 봇 토큰은 YOUR_TOKEN
```

---

## 아키텍처

```
[텔레그램 / 왓츠앱 / 디스코드]
         | 메시지
         v
[채널 어댑터] ─── grammy / Baileys / discord.js
         |
         v
[게이트웨이 데몬] ─── Node.js 백그라운드 프로세스
    |
    |── Message Store (SQLite) ─── 모든 메시지 영구 저장
    |── Memory Manager (FTS5) ─── 과거 대화 전문 검색
    |── Channel Manager ─── 어댑터 생명주기 관리
    |── Message Router ─── 아웃바운드 메시지 전달
    |── HTTP Server (:19280) ─── 대시보드 + REST API
    |── IPC Server (Unix socket) ─── Claude Code MCP 연결
    |
    └── AgentRunner ─── 핵심 에이전트 엔진
         |
         |── Agent SDK query() ─── Claude API 호출
         |── 인프로세스 MCP (9개 도구) ─── IPC 오버헤드 제로
         |── Session Resume ─── 대화별 연속성
         |── Persona Loader ─── SOUL + IDENTITY + USER + AGENTS
         |── Memory ─── MEMORY.md + 일별 로그 + FTS5
         |── 서브에이전트 ─── translator / researcher / coder
         |── Task Spawner ← v0.2.0 신규
         |    |── spawn_task (논블로킹)
         |    |── task_status (조회)
         |    |── 자동 announce
         |    └── 동시성 + 타임아웃 제어
         |── Hooks ─── PreToolUse / PostToolUse
         └── Skills ─── SKILL.md 로더
```

### 메시지 흐름

1. 사용자가 텔레그램에서 메시지 전송
2. 어댑터 수신 → Channel Manager → SQLite에 저장
3. AgentRunner가 `autoReply` + `allowFrom` 확인
4. 빠른 연속 메시지 배치 (1.5초 디바운스)
5. 페르소나 (4개 파일) + MEMORY.md + 스킬을 시스템 프롬프트로 로드
6. `query()`를 세션 리줌과 함께 호출
7. Claude가 판단: 직접 응답 or `spawn_task`로 무거운 작업 위임
8. `send_message`로 응답 → Router → 어댑터 → 사용자
9. 백그라운드 작업은 완료 시 자동으로 결과 announce
10. 모든 것이 `memory/YYYY-MM-DD.md` + FTS5 인덱스에 기록

---

## 페르소나 시스템

```
~/.openclaudecode/
├── SOUL.md       # 성격, 톤, 행동 규칙 (봇이 스스로 수정)
├── IDENTITY.md   # 봇의 이름과 역할
├── USER.md       # 사용자 이름, 선호도 (첫 대화에서 자동 생성)
├── AGENTS.md     # 커스텀 서브에이전트 정의
├── MEMORY.md     # 장기 기억 (200줄 상한)
├── memory/       # 일별 대화 로그
└── skills/       # SKILL.md 확장
```

첫 대화 시 봇이 온보딩 플로우를 실행합니다: 사용자 이름을 묻고, 자기 이름을 협상하고, 스타일 취향을 파악한 뒤, `write_persona`로 모든 것을 저장합니다. 페르소나는 대화가 쌓이면서 자연스럽게 진화합니다.

---

## MCP 도구

### 인터랙티브 (Claude Code → 게이트웨이, 13개)

| 도구 | 설명 |
|------|------|
| `gateway_status` | 데몬 상태, 업타임, 채널 |
| `gateway_start` | 데몬 시작 |
| `channel_connect` | 채널 연결 |
| `channel_disconnect` | 채널 연결 해제 |
| `channel_status` | 채널 연결 상태 |
| `send_message` | 수신자에게 메시지 전송 |
| `list_messages` | 메시지 목록 (필터 가능) |
| `list_conversations` | 활성 대화 목록 |
| `configure_channel` | 채널 설정 변경 |
| `auto_responder_status` | 에이전트 러너 상태 |
| `auto_responder_toggle` | 에이전트 활성화/비활성화 |
| `memory_search` | 과거 대화 전문 검색 |
| `memory_stats` | 메모리 인덱스 통계 |

### 인프로세스 (에이전트 → 게이트웨이, 9개)

| 도구 | 설명 |
|------|------|
| `send_message` | 사용자에게 응답 |
| `list_messages` | 대화 기록 조회 |
| `list_conversations` | 활성 채팅 목록 |
| `memory_search` | 과거 대화 검색 |
| `memory_stats` | 메모리 통계 |
| `read_persona` | 페르소나/메모리 파일 읽기 |
| `write_persona` | 페르소나/메모리 파일 수정 |
| **`spawn_task`** | 백그라운드 서브에이전트에 작업 위임 |
| **`task_status`** | 스폰된 작업 진행 상황 확인 |

---

## 서브에이전트

| 이름 | 모델 | 용도 |
|------|------|------|
| translator | Haiku | 언어 번역 |
| researcher | Haiku | 웹 검색, 정보 수집 |
| coder | Sonnet | 코드 생성 및 분석 |

### 커스텀 에이전트

`~/.openclaudecode/AGENTS.md`에 정의:

````markdown
```agent name=my-agent model=haiku
description: 이 에이전트가 하는 일
tools: Read, Grep, Bash
---
에이전트의 시스템 프롬프트
```
````

---

## 설정

`~/.openclaudecode/config.yaml`:

```yaml
gateway:
  port: 19280
  agentRunner:
    model: "claude-sonnet-4-5-20250929"
    maxConcurrent: 3
    debounceMs: 1500
    maxTurns: 10
    maxBudgetPerMessage: 999
    maxChildrenPerSession: 3    # 대화당 최대 백그라운드 작업 수
    taskTimeoutSeconds: 300     # 스폰된 작업 자동 중단 타임아웃
    sessionIdleMinutes: 120     # 비활동 세션 자동 만료 (0 = 만료 안 함)

channels:
  telegram:
    botToken: "YOUR_TOKEN"
    autoReply: true
    allowFrom: []  # 빈 배열 = 모든 사용자 허용
```

> `maxBudgetPerMessage`는 Agent SDK가 적용하는 메시지당 비용 상한 (USD)입니다. Claude Max 구독자는 과금이 구독 기반이므로 기본값(`999`)을 유지해도 안전합니다.

---

## 문제 해결

Claude Code에 직접 물어보세요 — 대부분 문제를 진단할 수 있습니다:

```
게이트웨이 상태 확인
텔레그램 연결 상태 확인
최근 메시지 보여줘
```

| 증상 | 해결 |
|------|------|
| 봇이 응답하지 않음 | `auto_responder_status` 확인 — autoReply가 꺼져 있을 수 있음 |
| "게이트웨이 실행 안 됨" | `Start the gateway` 또는 수동으로 데몬 실행 |
| 텔레그램 연결 끊김 | `Reconnect Telegram` |
| 텔레그램 `getMe` 오류 | VPN이 `api.telegram.org`을 차단할 수 있음 — 비활성화 또는 분할 터널링 |
| 특정 사용자만 허용 | `Add user123 to Telegram allowFrom` |
| 대화 리셋 | 채팅에서 `/new` 또는 `/reset` 전송 |
| 현재 작업 중지 | `/stop`, `/cancel`, `됐어`, `그만` 전송 |
| 페르소나 변경 | 자연스럽게 요청하거나, `~/.openclaudecode/SOUL.md` 직접 편집 |
| 백그라운드 작업이 멈춤 | `taskTimeoutSeconds` 후 자동 중단 (기본 300초) |
| 오래 쉰 후 이상한 응답 | `sessionIdleMinutes` 후 자동 만료 (기본 120분) |

### 대시보드

`http://127.0.0.1:19280` — 실시간 상태 확인.

---

## OpenClaw과의 비교

| | OpenClaw | OpenClaudeCode |
|---|---------|----------------|
| **범위** | 13+ 채널, 풀스택 AI OS | 6개 패키지, 경량 |
| **에이전트 엔진** | 자체 구축 | **Claude Agent SDK** (`query()`) |
| **작업 스포닝** | `sessions_spawn` + 오케스트레이터 | `spawn_task` + 자동 announce |
| **메모리** | 벡터 + BM25 하이브리드 | FTS5 + 페르소나 파일 + 일별 로그 |
| **페르소나** | SOUL.md, 수동 편집 | `write_persona`로 자기 진화 |
| **서브에이전트** | 커스텀 레지스트리 + 스폰 관리 | Agent SDK `agents` + AGENTS.md 커스텀 |
| **채널** | 13+ | 3 (텔레그램, 왓츠앱, 디스코드) |
| **설정** | Nix/Docker, 복잡한 설정 | `pnpm install && pnpm build` |
| **인증** | API 키 / 자체 관리 | Claude Max 구독 (키 불필요) |
| **보안** | Docker 샌드박스, DM 페어링 | allowFrom 화이트리스트, 훅 정책 |

**요약**: OpenClaw는 모든 걸 직접 만듭니다. OpenClaudeCode는 공식 Agent SDK 위에서 **동일한 핵심 기능을 훨씬 적은 코드로** 구현합니다.

---

## 변경 이력

### v0.3.0 (2026-04-08)
- **세션 idle timeout**: 비활동 세션 자동 만료 (기본 2시간), `sessionIdleMinutes`로 설정
- **토큰 추적**: 세션별 input/output 토큰 및 비용 누적, 디스크 영구 저장
- **메모리 flush**: 토큰이 160k (컨텍스트 80%) 도달 시 중요 컨텍스트를 MEMORY.md에 자동 저장
- **메시지 청킹**: 4000자 단위 마크다운 인식 분할 + 코드펜스 보존
- **컴팩트 envelope**: `[telegram Ryan +5m]` 포맷으로 경과 시간 기반 시간 인식
- **3-tier 메모리**: 글로벌(`user`) + 채널별(`channel`) 메모리 스코프, `read_persona`/`write_persona`의 scope 파라미터
- **인터럽트 모드**: `/stop`, `/cancel`, `됐어`, `그만`으로 활성 세션 즉시 중단

### v0.2.0 (2026-04-07)
- **`spawn_task`**: 논블로킹 백그라운드 서브에이전트 실행
- **`task_status`**: 스폰된 작업 진행 상황 조회
- **자동 announce**: 작업 완료 시 채팅에 결과 push
- **동시성 제어**: `maxChildrenPerSession`, `taskTimeoutSeconds`
- 서브에이전트 격리 (재귀 스폰 불가, 페르소나 수정 불가)

### v0.1.0 (2026-03-28)
- 최초 릴리스
- 게이트웨이 데몬 + 텔레그램/왓츠앱/디스코드 어댑터
- Agent SDK 연동 + 세션 리줌
- 멀티 파일 페르소나 시스템 (SOUL, IDENTITY, USER, AGENTS)
- FTS5 메모리 검색 + 일별 로그
- 내장 서브에이전트 (translator, researcher, coder)
- 스킬 시스템 (SKILL.md)
- 훅 기반 메시지 정책

---

## 라이선스

MIT License

Copyright (c) 2026 Jiwoong Kim ([@ico1036](https://github.com/ico1036))

오픈소스. 자유롭게 사용, 수정, 배포 가능합니다.
