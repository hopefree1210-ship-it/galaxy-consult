# GALAXY Consult — 별성형외과 일본 환자 비대면 사전상담

일본 환자가 인스타그램·틱톡 등에서 유입되어 **사전문진 → 비용 목안 → 채팅/화상 상담 예약 → 귀국 후 경과 체크**까지 한 곳에서 처리하는 웹앱(PWA)과 병원 직원용 관리 화면.

- 환자 화면(일본어): `https://도메인/`  · 직원 화면(한국어): `https://도메인/#staff`
- 스택: Node 22.13+ / Express / SQLite(Node 내장 node:sqlite, 별도 컴파일 불필요) / 바닐라 JS PWA. 외부 서비스 없이 서버 1대로 동작.

## 1. 로컬 실행
```bash
npm install
npm run dev            # http://localhost:3000  (직원 비밀번호 기본값: galaxy-dev, 개발 모드 한정)
npm test               # 서버 통합 테스트
```

## 2. 구조
```
server/index.js      API, 직원 인증, 웹훅 라우트
server/db.js         SQLite(node:sqlite) 스키마(cases, messages, config, ig_contacts)
server/logic.js      견적 계산, 술후 증상 분류 규칙(서버가 기준값 계산)
server/instagram.js  Instagram DM 웹훅·자동응답·알림
public/              환자·직원 SPA, manifest, service worker, 아이콘
```
환자는 접수 시 `case id + secret`을 받아 기기에 저장하고, 이 두 값으로만 자기 상담에 접근합니다. 직원은 비밀번호 로그인(서명된 HttpOnly 쿠키, 12시간).

## 3. 배포 (예: Fly.io / Railway / 병원 서버)
1. `.env.example`을 참고해 환경변수 설정. `BASE_URL`은 https 공개 주소.
2. 영구 볼륨을 `/data`에 연결(SQLite 파일 보관). `docker build -t galaxy . && docker run -p 3000:3000 -v galaxy-data:/data --env-file .env galaxy`
3. 반드시 HTTPS 뒤에서 운영(쿠키 Secure 설정은 `NODE_ENV=production`에서 켜짐).
4. DB 파일(`galaxy.db`)을 정기 백업.

## 4. 운영 전 필수 설정
- **가격표**: 직원 화면 → 가격표 탭에서 병원 실제 가격(만원), 체류일, 환율로 수정. 현재 값은 샘플.
- **자동 번역**: `ANTHROPIC_API_KEY`를 넣으면 직원이 한국어로 쓴 글을 일본어로, 환자 글을 한국어로 번역. 없으면 직원이 일본어를 직접 입력.
- **화상상담**: 직원이 Zoom/Google Meet 등 링크를 확정 시 입력(자체 영상통화는 2단계).

## 5. 인스타그램 계정 만들기와 연결
계정 생성은 전화/이메일 본인 인증이 필요해 **병원 담당자가 직접** 해야 합니다.
1. 별도 인스타그램 계정을 만들고 **프로페셔널 계정(비즈니스)** 으로 전환. 계정 이름은 일본어 사용자가 찾기 쉬운 이름으로(예: 한국어+일본어 병기).
2. 프로필 링크에 `https://도메인/?src=ig` 입력 → 이 링크로 들어온 상담은 직원 화면 「현황·SNS」에 Instagram 유입으로 집계. 틱톡은 `?src=tiktok`, LINE은 `?src=line`.
3. DM 자동응답까지 쓰려면 Meta 개발자 앱 생성(developers.facebook.com) → 제품 **Instagram** 추가 → 위 계정을 연결하고 `instagram_business_manage_messages` 권한 설정. 서비스 실사용에는 Meta **앱 검수**가 필요합니다.
4. 앱 설정의 Webhooks에서 콜백 URL `https://도메인/webhooks/instagram`, 확인 토큰 = `IG_VERIFY_TOKEN`, 구독 필드 `messages`.
5. `IG_APP_SECRET`(앱 시크릿), `IG_ACCESS_TOKEN`(Instagram 사용자 액세스 토큰, 장기 토큰은 만료 전에 갱신) 설정 후 재시작. `GET /healthz`에서 `instagram: true` 확인.
6. 동작: 누군가 DM을 보내면 일본어로 상담 링크(`?src=ig&ref=<ID>`)를 자동 발송(같은 사람에게 24시간에 1회). 상담이 접수되면 인스타 계정과 상담이 연결되어, 직원이 답변/화상 확정 시 인스타 DM으로 "새 메시지" 알림도 발송(6시간에 1회).
   - 자동응답 문구는 `server/instagram.js`의 `welcomeText`에서 수정. 인스타 DM은 사용자 메시지 후 24시간 안에만 답장 가능.

## 6. 법규·개인정보 체크리스트 (병원 법무 확인 필요)
- 온라인 상담은 **진단·처방이 아닌 정보 제공**임을 고지(앱 첫 화면·채팅 상단에 적용). 확정 진단·처방·"이 상담만으로 치료 가능" 표현 금지.
- 환자 동의 시각은 `consentAt`으로 저장. 사진·병력은 민감정보이므로 별도 동의 문구와 보관 기간 정책을 확정하세요. 국외(일본→한국) 이전 동의, 일본 개인정보보호법, 한국 개인정보보호법 검토 필요.
- SNS 게시물(전후 사진, 후기, 이벤트)은 한국 의료광고 규정과 일본 의료광고 가이드라인 확인 후 게시.
- 외국인환자 유치 등록·수수료 규정은 별도 확인.

## 7. 다음 단계
자체 화상통화(WebRTC), LINE 연동, 직원 개별 계정/권한, 사진 파일 스토리지 분리, 감사 로그, 푸시 알림, 틱톡 유입 자동화.
