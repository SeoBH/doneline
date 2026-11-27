/// <reference types="vite/client" />

// .d.ts는 실행 코드가 아니라 TypeScript에 파일·값의 타입을 알려주는 선언 파일이다.
// 위 지시문은 Vite가 제공하는 CSS·이미지 import와 import.meta.env의 타입을 불러온다.
// 실제 CSS 적용은 Vite가 담당하며, 이 선언은 편집기와 타입 검사가 해당 import를 이해하게 한다.

// 빌드 때 넣는 값의 타입. VITE_CONTACT_EMAIL: 약관·방침·로그인 화면의 문의 메일(PolicyLinks.tsx, 배포 스크립트가 채움).
interface ImportMetaEnv {
  readonly VITE_CONTACT_EMAIL?: string;
}
