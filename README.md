# Message Meta

SillyTavern 메시지의 상세 토큰 사용량과 응답 정보를 표시하는 UI 확장입니다. 특정 테마 전용이 아니며 SillyTavern의 SmartTheme 색상 변수를 사용하므로, 지금 쓰는 테마에 맞춰 팝업과 보조 글자 색이 바뀝니다.

## 기능

- 아바타 아래 토큰 카운터를 누르면 **메시지 정보** 팝업 표시
  - API, 모델, 응답 시간, 첫 토큰까지 걸린 시간
  - 응답에 사용량이 들어 있으면 Input / Output / Thinking / Total 토큰
- 스와이프마다 사용량을 따로 저장
- AI에서 숨긴 일반 메시지에도 같은 형식 적용(실제 시스템 알림은 제외)

## 설치

SillyTavern → 확장(Extensions) → **Install extension**에 이 저장소 주소를 넣습니다.

```text
https://github.com/STLoft/Message-Meta
```

설치 후 페이지를 새로 고칩니다. 브라우저 개발자도구 Console에 `[Message Meta] v1.5.0 loaded`가 보이면 로드된 것입니다.

## 토큰 사용량

사용량은 답장을 생성할 때 응답에서 읽어 그 메시지와 함께 채팅에 저장합니다. 한 번 저장된 사용량은 시간이 지나도 계속 볼 수 있습니다. 확장을 설치하기 전에 만든 메시지에는 저장된 값이 없어 SillyTavern이 센 메시지 토큰 수만 표시됩니다.

- OpenAI 호환 연결 등 응답에 사용량이 들어 있는 경우: 이 확장만으로 표시됩니다.
- Gemini / Vertex AI에 직접 연결하고 스트리밍을 끈 경우: 응답에 사용량이 빠져 있어, 서버 플러그인 [Usage Bridge](https://github.com/STLoft/Usage-Bridge)를 함께 설치해야 표시됩니다.
- 모델이 응답에 넣어 주지 않은 항목(예: Thinking)은 팝업에서 그 줄만 빠집니다.

Thinking 토큰이 Output에 포함된 값인지 별도인지는 연결 방식마다 다르며, 구분할 수 있을 때 팝업 아래에 안내가 나옵니다.

## 테마

다음 SillyTavern 공통 변수를 따릅니다.

- `--SmartThemeBodyColor`
- `--SmartThemeUnderlineColor`
- `--SmartThemeBorderColor`
- `--SmartThemeBlurTintColor`
- `--mainFontSize`
