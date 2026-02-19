# MangoAuto - Chrome Extension

## Auto-commit rule (현재 비활성)
<!-- 서버 작업 중이므로 자동 커밋/푸시 중단. 필요 시 GitHub에서 pull 받아올 것. -->
<!-- 코드 변경 작업이 완료될 때마다 자동으로 git commit & push를 수행할 것. -->
<!-- - 변경된 파일만 stage하여 커밋 -->
<!-- - 커밋 메시지는 변경 내용을 한국어로 간결하게 작성 -->
<!-- - 커밋 후 `git push origin main` 실행 -->
자동 커밋/푸시 비활성 상태. 커밋은 사용자가 요청할 때만 수행.

## Project Structure
- `manifest.json` - Extension manifest (MV3)
- `background/background.js` - Service worker (orchestrator)
- `content/grok.js` - Grok content script
- `content/flow.js` - Veo3/Flow content script
- `content/whisk.js` - ImageFX content script
- `content/shared-dom.js` - Shared DOM utilities
- `content/inject.js` - MAIN world injector
- `popup/` - Side panel UI
- `lib/utils.js` - Utility functions
- `lib/mangohub-api.js` - MangoHub API client
- `lib/state-machine.js` - Automation state machine
- `참고자료/` - Reference implementation

## Key Conventions
- Platform: Chrome Extension Manifest V3
- No build tools (vanilla JS)
- MangoHub server: https://mangois.love
