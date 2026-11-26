# RisuAI 리버스 프록시 설정

RisuAI에서 OpenAI와 Anthropic 모델을 사용하는 방법입니다. **공급자 API 키는 Render에 저장하고, RisuAI에는 프록시 토큰만 입력합니다.** 이미 배포된 프록시의 주소와 토큰을 받았다면 [RisuAI 연결](#3-risuai-연결)부터 진행하세요.

## 1. Render에 프록시 배포

1. Render 대시보드에서 **New → Web Service**를 선택하고 이 GitHub 저장소를 연결합니다.
2. 브랜치는 `main`, 런타임은 `Node`로 설정하고 **Root Directory**는 비워 둡니다. **Build Command**에 `node --version`, **Start Command**에 `node src/server.ts`, **Health Check Path**에 `/healthz`를 입력합니다.
3. 아래 환경 변수를 입력하고 **Deploy Web Service**를 누릅니다. 상태가 **Live**가 되면 서비스의 HTTPS 주소를 복사합니다. 브라우저에서 그 주소 뒤에 `/healthz`를 붙여 열면 `{"status":"ok"}`가 표시됩니다.

공식 RisuAI 웹을 쓰면 프록시 서비스 하나로 충분합니다. RisuAI 웹도 함께 호스팅하려면 [기존 영문 문서의 Blueprint 배포 절차](../README.md#deploy-on-render)를 참고하세요.

## 2. Render 환경 변수

[Render 환경 변수 예시](../render.env.example)는 프록시를 단독 배포할 때 쓰는 13개 변수를 담고 있습니다. 새 서비스에는 사용할 공급자의 API 키와 직접 생성한 프록시 토큰을 채웁니다. 기존 서비스의 설정을 수정할 때는 저장된 키와 토큰을 유지하고 **Environment → Edit**에서 필요한 값만 변경합니다.

같은 공급자의 API 키가 여러 개면 쉼표로 구분합니다. 프록시는 사용 가능한 키를 순서대로 선택합니다.

| 환경 변수 | 설정값 | 용도 |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI API 키 | GPT 모델 호출 |
| `ANTHROPIC_API_KEY` | Anthropic API 키 | Claude 모델 호출 |
| `PROXY_TOKENS` | Render의 **Generate**로 만든 별도 토큰 | RisuAI의 **키/패스워드**에 입력. 여러 토큰은 쉼표로 구분 |
| `ALLOWED_ORIGINS` | `https://risuai.xyz` | 접속할 RisuAI 웹 주소. 다른 프런트엔드는 `ADDITIONAL_ALLOWED_ORIGINS`에 추가 가능 |
| `NODE_VERSION` / `SKIP_INSTALL_DEPS` | `24.22.3` / `true` | Node 버전 고정 및 의존성 설치 생략 |

| 사용 한도 환경 변수 | 예시 설정값 | 적용 범위 |
| --- | ---: | --- |
| `OPENAI_MAX_INPUT_TOKENS` / `OPENAI_MAX_OUTPUT_TOKENS` | `100000` / `10000` | OpenAI 요청 1건의 입력 / 출력 토큰 |
| `ANTHROPIC_MAX_INPUT_TOKENS` / `ANTHROPIC_MAX_OUTPUT_TOKENS` | `100000` / `10000` | Anthropic 요청 1건의 입력 / 출력 토큰 |
| `REQUESTS_PER_MINUTE` | `3` | 같은 프록시 토큰과 IP에서 최근 60초간 사용이 확인된 생성 횟수. 두 공급자 합산 |
| `MAX_ACTIVE_PER_USER` | `8` | 같은 프록시 토큰과 IP에서 동시에 처리할 요청 수 |
| `MAX_BODY_BYTES` | `33554432` | 요청 본문 크기(32 MiB) |

## 3. RisuAI 연결

[RisuAI 웹](https://risuai.xyz/)에서 **고급 설정 → 비권장 설정 보이기 → 직접 요청 보내기**를 켭니다. 아래 `<프록시>`는 Render의 HTTPS 서비스 주소입니다.

| 공급자 API | Custom API의 포맷 | 커스텀 모델의 포맷 | 입력할 전체 URL |
| --- | --- | --- | --- |
| OpenAI Responses | `OpenAI Response API` | `OpenAIResponseAPI` | `<프록시>/v1/responses` |
| OpenAI Chat Completions | `OpenAI Compatible` | `OpenAICompatible` | `<프록시>/v1/chat/completions` |
| Anthropic Messages | `Anthropic Claude` | `Anthropic` | `<프록시>/v1/messages` |

**Custom API · 한 모델을 바로 연결할 때**

1. 모델 선택기에서 **Custom API**를 선택합니다.
2. **포맷**과 **URL**을 위 표의 같은 행에서 가져옵니다. **요청 모델**에는 공급자의 모델 ID를, **키/패스워드**에는 `PROXY_TOKENS`에 등록한 토큰 하나를 입력합니다. 모델을 바꾸면 이 설정을 함께 갱신합니다.

**커스텀 모델(Custom Model) · 여러 모델을 저장해 전환할 때**

1. **고급 설정** → **커스텀 모델** → + 에서 항목을 만듭니다. **이름**에는 목록에 표시할 이름을, **요청 모델**에는 공급자의 모델 ID를 입력합니다.
2. 위 표의 **포맷**과 **URL**을 입력하고 **키/패스워드**에 프록시 토큰 하나를 넣습니다. 시스템 프롬프트는 OpenAI에 `hasFullSystemPrompt`, Claude에 `hasFirstSystemPrompt`를 선택합니다. 스트리밍을 쓰려면 `hasStreaming`과 RisuAI의 스트리밍 설정을 모두 켭니다.
3. 모델 선택기에서 저장한 이름을 선택합니다. **모델**과 **보조 모델**에 서로 다른 항목을 지정할 수 있습니다.

모델 ID는 프록시 토큰을 `Authorization: Bearer <프록시 토큰>` 헤더에 넣어 `GET <프록시>/v1/models`를 호출하면 `data[].id`에서 확인할 수 있습니다. 연결 확인은 짧은 텍스트 메시지로 합니다. Chat Completions 모델이 `max_completion_tokens`를 요구하면 커스텀 모델에서 `OAICompletionTokens`를 켭니다.

[영문 상세 문서](../README.md) · [Render 환경 변수 예시](../render.env.example)
