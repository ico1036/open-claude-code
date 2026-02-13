# OpenClaudeCode 개선안: 코드 포맷팅 + 멀티태스킹

## Context

두 가지 핵심 문제:
1. **코드 스니펫/스크린샷 미표시** — Claude가 send_message로 보내는 텍스트가 Telegram에서 plain text로 전송됨 (parse_mode 미설정, 미디어 미지원)
2. **멀티태스킹 불가** — 긴 작업(예: `sleep 600`) 중 같은 유저의 새 메시지가 세션 완료까지 대기됨

---

## Issue 1: 코드 스니펫/이미지 미표시

### 근본 원인
- `adapter-telegram/src/index.ts:161` — `sendMessage(chatId, msg.text, params)` → `parse_mode` 없음
- `agent-mcp.ts:39-49` — `send_message` 도구가 `text`만 받음, `media` 파라미터 없음
- `OutboundMessage` 타입에 `media?: MessageMedia[]` 이미 정의돼 있지만 미사용

### 변경 계획

#### 1-1. Telegram Markdown→HTML 변환기 (새 파일)
**파일:** `packages/adapter-telegram/src/format.ts`

`markdownToTelegramHtml(text: string): string` 함수 생성:
- ` ```lang\ncode\n``` ` → `<pre><code class="language-lang">...</code></pre>`
- `` `code` `` → `<code>code</code>`
- `**bold**` → `<b>bold</b>`, `_italic_` → `<i>italic</i>`
- `[text](url)` → `<a href="url">text</a>`
- `<`, `>`, `&` → HTML entity escape
- try/catch로 감싸서 실패 시 plain text fallback

HTML 선택 이유: MarkdownV2는 20개+ 특수문자 이스케이프 필요, Claude 출력과 호환 어려움

#### 1-2. 텍스트 청킹 유틸 (새 파일)
**파일:** `packages/adapter-core/src/chunk.ts`

`chunkText(text: string, maxLen: number): string[]` 함수:
- 빈 줄 > 줄바꿈 > 공백 순으로 분할 우선순위
- 코드 펜스 안에서 분할 시 닫고 다음 청크에서 다시 열기
- Telegram: 4096자, Discord: 2000자 제한 대응
- `adapter-core/src/index.ts`에서 export

#### 1-3. Telegram 어댑터 send() 수정
**파일:** `packages/adapter-telegram/src/index.ts` (send 메서드, line 147-177)

```
1. markdown → HTML 변환 (try/catch, 실패 시 plain text)
2. 청킹 (HTML 변환 전 markdown 기준 ~3800자로 분할)
3. 각 chunk를 parse_mode: "HTML"로 sendMessage
4. msg.media 처리: sendPhoto / sendDocument (grammY InputFile 사용)
```

#### 1-4. send_message MCP 도구에 media 파라미터 추가
**파일:** `packages/gateway/src/agent-mcp.ts` (line 36-61)

```typescript
media: z.array(z.object({
  type: z.enum(["image", "document"]),
  data: z.string(),        // base64
  mimeType: z.string().optional(),
  fileName: z.string().optional(),
  caption: z.string().optional(),
})).optional()
```

tool handler에서 `outbound.media`에 Buffer.from(data, "base64")로 변환하여 전달

---

## Issue 2: 멀티태스킹 부재

### 근본 원인
- `agent-runner.ts:734` — `activeSessions.has(key)` 이면 processQueue가 즉시 return
- 같은 유저의 새 메시지는 세션이 끝날 때까지 큐에 쌓이기만 함
- Agent SDK `Query` 인터페이스에 `streamInput()`, `interrupt()` 메서드 존재 확인 (sdk.d.ts:1062-1068)

### 변경 계획

#### 2-1. activeQueries 맵 추가
**파일:** `packages/gateway/src/agent-runner.ts`

```typescript
private activeQueries = new Map<string, {
  query: Query;
  abortController: AbortController;
}>();
```

`invokeAgent()`에서 `query()` 호출 후 저장, finally에서 삭제

#### 2-2. processQueue 수정 — 활성 세션에 메시지 주입
**파일:** `packages/gateway/src/agent-runner.ts` (line 727-755)

```
processQueue(key):
  if activeSessions.has(key) && activeQueries.has(key):
    → injectMessages(key, messages)  // streamInput 사용
    return
  // 기존 로직 (새 세션 시작)
```

#### 2-3. injectMessages 메서드 추가
**파일:** `packages/gateway/src/agent-runner.ts`

```typescript
private async injectMessages(key: string, messages: ChannelMessage[]): Promise<void> {
  const active = this.activeQueries.get(key);
  if (!active) return;

  const messageTexts = messages.map(m => m.text ?? "(media)").join("\n");

  // SDKUserMessage 형태로 변환 후 streamInput 호출
  const stream = async function*() {
    yield {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: `[New message while working]\n${messageTexts}` }],
      },
    };
  }();

  try {
    await active.query.streamInput(stream);
  } catch {
    // 실패 시 큐에 다시 넣기 (기존 동작 fallback)
    this.queues.get(key)?.push(...messages.map(m => ({ message: m })));
  }
}
```

#### 2-4. /cancel, /stop 인터럽트 지원
**파일:** `packages/gateway/src/agent-runner.ts`

`handleMessage()`에서 `/cancel`, `/stop` 감지 시:
- `activeQueries.get(key)?.query.interrupt()` 호출
- 실패 시 `abortController.abort()` fallback

`RESET_COMMANDS` 배열에 `/cancel`, `/stop` 추가

#### 2-5. maxConcurrent 기본값 상향
**파일:** `packages/gateway/src/config.ts` (line 24)

`maxConcurrent` 기본값: 3 → 10
(Node.js async iterator는 이벤트 루프를 블로킹하지 않으므로 안전)

---

## 구현 순서

| 단계 | 작업 | 파일 |
|------|------|------|
| 1 | format.ts 생성 (MD→HTML) | `adapter-telegram/src/format.ts` (신규) |
| 2 | chunk.ts 생성 + export | `adapter-core/src/chunk.ts` (신규), `adapter-core/src/index.ts` |
| 3 | Telegram send() 수정 (포맷+청킹+미디어) | `adapter-telegram/src/index.ts` |
| 4 | send_message에 media 추가 | `gateway/src/agent-mcp.ts` |
| 5 | activeQueries + streamInput + interrupt | `gateway/src/agent-runner.ts` |
| 6 | maxConcurrent 기본값 변경 | `gateway/src/config.ts` |

단계 1-2는 병렬, 3-4는 1-2 의존, 5-6은 독립적으로 병렬 가능

---

## 검증 방법

### Issue 1 테스트
1. Gateway 빌드 후 Telegram으로 코드가 포함된 질문 전송
2. 응답에서 `<pre><code>` 포맷으로 코드 블록 렌더링 확인
3. 4096자 이상 응답이 여러 메시지로 분할되는지 확인
4. 이미지가 있는 경우 sendPhoto로 전송되는지 확인

### Issue 2 테스트
1. 긴 작업 요청 (예: "10초 sleep 후 결과 알려줘")
2. 작업 중 새 메시지 전송 → streamInput으로 주입되어 Claude가 인식하는지 확인
3. `/cancel` 전송 → 진행 중인 작업이 interrupt 되는지 확인
4. 다른 유저가 동시에 메시지 전송 → maxConcurrent 범위 내 병렬 처리 확인
