/**
 * 입력 형식 오류를 사용자가 이해할 수 있는 한국어 문장으로 바꾼다.
 * 전역 ValidationPipe(app.ts)가 DTO 검사에 실패하면 기본값 "Bad Request Exception" 대신 이 문장을 응답한다.
 * 필드 이름을 화면 표시 이름과 형식 안내로 바꾸고, 선언되지 않은 필드(위조 요청 등)는 따로 알린다.
 */
import { BadRequestException, ValidationError } from '@nestjs/common';

// DTO 속성 → 화면에 보이는 이름(형식 안내 포함). 목록에 없으면 속성 이름을 그대로 쓴다.
const LABELS: Record<string, string> = {
  workspaceCode: '업체 코드(영문 소문자·숫자·하이픈 2~40자)',
  workspaceName: '업체명',
  loginId: '아이디(영문·숫자·_ . - 조합)',
  name: '이름',
  email: '이메일',
  mobile: '휴대전화(숫자 7자리 이상)',
  password: '비밀번호(15~128자)',
  currentPassword: '현재 비밀번호',
  newPassword: '새 비밀번호(15~128자)',
  title: '제목',
  body: '내용',
  category: '구분',
  priority: '긴급도',
  corporationId: '법인',
  departmentId: '부서',
  comment: '답변',
  status: '상태',
  assigneeId: '담당자',
  internal: '내부 메모 여부',
  version: '버전(다시 조회 후 시도)',
  responseHours: '첫 응답 기한',
  resolveHours: '처리 기한',
  kind: '구분',
  page: '화면',
  token: '링크',
  purpose: '링크 종류',
  signupToken: '가입 링크',
  rows: '목록',
  ids: '대상',
};

/** 중첩 오류(배열 안의 객체 등)까지 펼쳐 실패한 필드 이름을 모은다. */
function collect(errors: ValidationError[], out: { unknown: string[]; invalid: string[] }) {
  for (const e of errors) {
    if (e.constraints?.whitelistValidation) out.unknown.push(e.property);
    else if (e.constraints) out.invalid.push(LABELS[e.property] || e.property);
    if (e.children?.length) collect(e.children, out);
  }
  return out;
}

export function validationError(errors: ValidationError[]) {
  const { unknown, invalid } = collect(errors, { unknown: [], invalid: [] });
  const parts: string[] = [];
  if (invalid.length) parts.push('입력값을 확인해주세요: ' + [...new Set(invalid)].join(', '));
  if (unknown.length)
    parts.push('허용되지 않은 항목이 포함되었습니다: ' + [...new Set(unknown)].join(', '));
  return new BadRequestException(parts.join(' / ') || '입력값을 확인해주세요.');
}
