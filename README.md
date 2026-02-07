# OpenClaudeCode

**v0.1.0**

Claude Code를 멀티채널 메시징 AI 비서로 만드는 오픈소스 프로젝트.
Telegram, WhatsApp, Discord에 연결하면 Claude가 자동으로 메시지에 응답하고, 대화를 통해 스스로 페르소나를 형성하며, 장기 기억을 유지합니다.

Claude Max 구독만 있으면 API 키 없이 바로 사용할 수 있습니다.

---

## Quick Start

### 1. 준비물

- **Node.js** 22 이상
- **pnpm** (`npm install -g pnpm`)
- **Claude Code** CLI 설치 + 로그인 완료 (`claude --version`으로 확인)
- **Telegram Bot Token** (아래 참고)

### 2. 설치

```bash
git clone https://github.com/JW-Corp/open-claude-code.git
cd open-claude-code
pnpm install
pnpm -r build
```

### 3. Telegram 봇 만들기

1. Telegram에서 `@BotFather` 검색
2. `/newbot` 전송 → 이름 입력 → 봇 토큰 복사

### 4. 실행

```bash
# 데몬 시작
node packages/gateway/dist/gateway-daemon.js
```

별도 터미널에서 Claude Code 열기:

```bash
cd open-claude-code
claude
```

Claude에게 말하기:

```
텔레그램 봇 연결해줘, 토큰은 7123456789:AAHxxxxxxx
```

```
텔레그램 자동응답 켜줘
```

끝. 이제 Telegram으로 메시지를 보내면 Claude가 자동 응답합니다.

### 5. 컴퓨터 재시작 후 자동 실행 (선택)

```bash
pnpm daemon:install
```

macOS launchd 서비스로 등록됩니다. 로그인 시 자동 시작, 크래시 시 자동 재시작.

### WhatsApp / Discord

```
# WhatsApp — QR 코드가 로그에 표시됨, 스캔하면 연결
WhatsApp 연결해줘

# Discord — Developer Portal에서 봇 토큰 발급 필요
Discord 봇 연결해줘, 토큰은 YOUR_TOKEN
```

---

## 에러 대응

문제가 생기면 Claude Code에서 직접 물어보세요. 에이전트가 알아서 진단합니다.

```
게이트웨이 상태 확인해줘
```

```
텔레그램 연결 상태 보여줘
```

```
최근 메시지 목록 보여줘
```

### 자주 발생하는 문제

| 증상 | 해결 |
|------|------|
| 봇이 응답 안 함 | `자동응답 상태 확인해줘` → autoReply가 꺼져 있을 수 있음 |
| "Gateway daemon is not running" | `게이트웨이 시작해줘` 또는 `node packages/gateway/dist/gateway-daemon.js` |
| 텔레그램 연결 끊김 | `텔레그램 다시 연결해줘` |
| 특정 사람만 응답하고 싶음 | `텔레그램 설정에서 allowFrom에 user123 추가해줘` |
| 세션 리셋하고 싶음 | Telegram에서 `/new` 또는 `/reset` 전송 |
| 페르소나 바꾸고 싶음 | Telegram에서 대화로 자연스럽게 요청하거나, `~/.openclaudecode/SOUL.md` 직접 편집 |

### 대시보드

브라우저에서 `http://127.0.0.1:19280` 접속하면 실시간 상태를 확인할 수 있습니다.

---

## vs OpenClaw

OpenClaudeCode는 [OpenClaw](https://github.com/nicholasgriffintn/openclaw)에서 영감을 받았지만, 설계 철학이 다릅니다.

| | OpenClaw | OpenClaudeCode |
|---|---------|----------------|
| **규모** | 13+ 채널, 수천 줄, 풀스택 플랫폼 | 6 패키지, 경량, 핵심에 집중 |
| **에이전트 엔진** | 자체 구현 (세션 관리, 라우팅, 샌드박스) | **Claude Agent SDK** 네이티브 (`query()`) |
| **메모리** | 벡터 임베딩 + BM25 하이브리드 검색 | FTS5 + 페르소나 파일 + 일일 로그 (로컬, 외부 의존 없음) |
| **페르소나** | SOUL.md 수동 편집 | 봇이 **대화를 통해 스스로 진화** (`write_persona`) |
| **서브에이전트** | 자체 레지스트리 + 스폰 관리 | Agent SDK `agents` 옵션 (translator, researcher, coder) |
| **채널** | 13+ (Teams, Matrix, Zalo, iMessage...) | 3 (Telegram, WhatsApp, Discord) — 핵심만 |
| **설정** | JSON 스키마 + Doctor 도구 | YAML, Claude Code에게 말로 설정 |
| **보안** | DM 페어링, Docker 샌드박스, 도구 정책 | allowFrom 화이트리스트, 훅 기반 메시지 정책 |
| **인증** | API 키 or OAuth 직접 관리 | Claude Max 구독 자동 인증 (키 불필요) |
| **설치** | Nix/Docker/수동, 복잡한 설정 | `pnpm install && pnpm -r build` 끝 |
| **확장** | Plugin SDK, ClawHub 레지스트리 | Skills (`SKILL.md`), AGENTS.md 커스텀 에이전트 |

**한마디 요약**: OpenClaw는 모든 것을 직접 만든 풀스택 AI OS. OpenClaudeCode는 Claude Agent SDK 위에 얹어서 **적은 코드로 동일한 핵심 기능**을 구현합니다.

---

## 작동 원리

### 전체 구조

```
[Telegram/WhatsApp/Discord 사용자]
         │ 메시지
         v
[Channel Adapters] ─── grammY / Baileys / discord.js
         │
         v
[Gateway Daemon] ─── Node.js 백그라운드 프로세스
    │
    ├── Message Store (SQLite) ─── 모든 메시지 저장
    ├── Memory Manager (FTS5) ─── 과거 대화 전문 검색
    ├── Channel Manager ─── 어댑터 생명주기 관리
    ├── Message Router ─── 아웃바운드 메시지 라우팅
    ├── HTTP Server ─── 대시보드 + REST API
    ├── IPC Server ─── Claude Code MCP 연결 (Unix socket)
    │
    └── AgentRunner ─── 핵심 에이전트 엔진
         │
         ├── Agent SDK query() ─── Claude API 호출
         ├── In-process MCP (7 tools) ─── IPC 없이 직접 실행
         ├── Session Resume ─── 대화별 세션 연속성
         ├── Persona Loader ─── SOUL + IDENTITY + USER + AGENTS
         ├── Memory ─── MEMORY.md + daily logs
         ├── Subagents ─── translator / researcher / coder
         ├── Hooks ─── PreToolUse(정책) / PostToolUse(로깅)
         └── Skills ─── SKILL.md 로더
```

### 메시지 처리 흐름

1. 사용자가 Telegram에 메시지 전송
2. Channel Adapter가 수신 → Channel Manager로 전달
3. Message Store에 SQLite 저장
4. AgentRunner가 수신: autoReply 활성화 + allowFrom 확인
5. 동일 사용자 메시지를 1.5초간 모아서 배치 (debounce)
6. 페르소나 파일 4개 + MEMORY.md + 스킬 목록을 시스템 프롬프트로 조합
7. Agent SDK `query()` 호출 (세션 resume 포함)
8. Claude가 `send_message` 도구로 응답 → Message Router → Channel Adapter → 사용자에게 전달
9. 대화 로그를 `memory/YYYY-MM-DD.md`에 기록

### 페르소나 시스템

```
~/.openclaudecode/
├── SOUL.md       # 성격, 톤, 행동 규칙 (봇이 스스로 수정 가능)
├── IDENTITY.md   # 이름, 역할
├── USER.md       # 사용자 이름, 선호도 (대화 중 자동 생성)
├── AGENTS.md     # 커스텀 서브에이전트 정의
└── MEMORY.md     # 장기 기억 (시스템 프롬프트에 주입, 200줄 제한)
```

첫 대화에서 봇이 사용자 이름과 자신의 이름을 물어보고, 성격을 협의하고, `write_persona` 도구로 자동 저장합니다. 이후 대화가 쌓이면서 페르소나가 자연스럽게 진화합니다.

### 메모리 계층

| 계층 | 저장소 | 용도 |
|------|--------|------|
| 세션 컨텍스트 | Agent SDK 내부 | 현재 대화 연속성 |
| 페르소나 파일 | `~/.openclaudecode/*.md` | 정체성, 성격, 사용자 정보 (매 세션 시작시 로드) |
| 일일 로그 | `memory/YYYY-MM-DD.md` | 시간순 대화 기록 |
| 장기 기억 | `MEMORY.md` | 중요한 사실 (봇이 직접 기록) |
| 전문 검색 | SQLite FTS5 | 과거 모든 대화에서 키워드 검색 |

### MCP 도구

**Interactive (Claude Code에서 사용, 13개)**:
gateway_status, gateway_start, channel_connect, channel_disconnect, channel_status, send_message, list_messages, list_conversations, configure_channel, auto_responder_status, auto_responder_toggle, memory_search, memory_stats

**In-process (Agent가 사용, 7개)**:
send_message, list_messages, list_conversations, memory_search, memory_stats, read_persona, write_persona

### 서브에이전트

| 이름 | 모델 | 역할 |
|------|------|------|
| translator | Haiku | 번역 |
| researcher | Haiku | 웹 검색/정보 수집 |
| coder | Sonnet | 코드 생성/분석 |

AGENTS.md에서 커스텀 에이전트 추가:

````markdown
```agent name=my-agent model=haiku
description: 이 에이전트가 하는 일
tools: Read, Grep, Bash
---
시스템 프롬프트 내용
```
````

### 설정

`~/.openclaudecode/config.yaml`:

```yaml
gateway:
  port: 19280

agentRunner:
  model: "claude-sonnet-4-5-20250929"
  maxConcurrent: 3
  debounceMs: 1500
  maxTurns: 10
  maxBudgetPerMessage: 0.50

channels:
  telegram:
    botToken: "YOUR_TOKEN"
    autoReply: true
    allowFrom: []      # 빈 배열 = 모든 사용자 허용
```

---

## License

MIT License

Copyright (c) 2026 Jiwoong Kim ([@JW-Corp](https://github.com/JW-Corp))

이 프로젝트는 오픈소스입니다. 자유롭게 사용, 수정, 배포할 수 있습니다.
