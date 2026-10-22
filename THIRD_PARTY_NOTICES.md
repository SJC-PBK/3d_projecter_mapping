# 쓰는 라이브러리와 라이선스

이 저장소에는 아래 라이브러리의 코드가 들어 있지 않습니다. `npm install` 때 npm 에서 받습니다.

## 실행에 필요 (서버)

| 라이브러리 | 라이선스 | 용도 |
|---|---|---|
| [ws](https://github.com/websockets/ws) | MIT | WebSocket 서버 (화면 사이 동기화) |
| [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) | Apache-2.0 (포함된 QRCode for JavaScript © Kazuhiko Arase: MIT) | 서버 시작 시 리모컨 주소 QR 출력 |

"QR Code" 는 DENSO WAVE INCORPORATED 의 등록 상표입니다.

## 개발·빌드에만 필요

| 라이브러리 | 라이선스 |
|---|---|
| [Vite](https://vite.dev/) | MIT |
| [Vitest](https://vitest.dev/) | MIT |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 |
| @types/node, @types/ws | MIT |

`npm run build` 결과물(dist/)에는 Vite 가 만든 작은 런타임 코드(모듈 미리 불러오기, MIT)가 들어갈 수 있습니다.

## 포함된 자료

`public/assets/` 의 테스트 패턴(grid·grid-white·checker·circles.png)과 샘플 영상(sample.mp4, ffmpeg 내장 시험 신호 testsrc2 로 생성)은 이 프로젝트에서 만든 것으로, 이 저장소의 MIT 라이선스를 따릅니다.
