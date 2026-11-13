/**
 * 첫 화면 '시작하기' 안내. 탭이 하나도 열려 있지 않을 때 업체 직원에게 처음 해야 할 일을 순서대로 보여 준다.
 * 각 단계의 완료 여부는 GET /api/workspaces/onboarding(건수)으로 판단하고, [열기]로 해당 화면을 바로 연다.
 * 업체 직원이 아니면(고객사 사용자) 메뉴 선택 안내만 보여 준다.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { User } from './types';

type Counts = {
  customers: number;
  corporations: number;
  departments: number;
  staff: number;
  customerUsers: number;
  pendingUsers: number;
  requests: number;
};

export function StartGuide({
  user,
  canOpen,
  onOpen,
}: {
  user: User;
  canOpen: (code: string) => boolean;
  onOpen: (code: string) => void;
}) {
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    if (!user.staff) return;
    // 진행 현황은 보조 정보라 실패하면 안내 문구만 보여 준다.
    api('workspaces/onboarding')
      .then(setCounts)
      .catch(() => setCounts(null));
  }, [user.staff]);
  if (!user.staff || !counts)
    return <div className="empty">왼쪽 메뉴에서 화면을 선택해주세요.</div>;
  // [화면 코드, 제목, 설명, 완료 여부]. 순서대로 하면 고객이 첫 요청을 올릴 수 있는 상태가 된다.
  const steps: [string, string, string, boolean][] = [
    [
      'CUSTOMER_REGISTER',
      '고객사 등록',
      '유지보수 계약을 맺은 고객사를 추가합니다.',
      counts.customers > 0,
    ],
    [
      'CORPORATION_REGISTER',
      '법인 등록',
      '고객사의 법인(사업장)을 추가합니다.',
      counts.corporations > 0,
    ],
    [
      'DEPARTMENT_REGISTER',
      '부서 등록',
      '요청을 올릴 고객 부서를 추가합니다.',
      counts.departments > 0,
    ],
    [
      'USER_REGISTER',
      '우리 직원 등록',
      '요청을 처리할 엔지니어를 추가하고 비밀번호 설정 링크를 전달합니다.',
      counts.staff > 1,
    ],
    [
      'CUSTOMER_REGISTER',
      '고객에게 가입 링크 전달',
      '고객사등록에서 고객사를 선택하고 [가입 링크 복사]를 눌러 고객 담당자에게 보냅니다.',
      counts.customerUsers + counts.pendingUsers > 0,
    ],
    [
      'USER_REGISTER',
      '가입 신청 승인',
      counts.pendingUsers
        ? `승인을 기다리는 신청이 ${counts.pendingUsers}건 있습니다.`
        : '가입 신청이 오면 역할과 소속 부서를 지정해 승인합니다.',
      counts.customerUsers > 0 && counts.pendingUsers === 0,
    ],
    [
      'SR_DESK',
      '첫 요청 처리',
      '고객 요청이 들어오면 요청 작업함에서 배정·답변합니다.',
      counts.requests > 0,
    ],
  ];
  const done = steps.filter((s) => s[3]).length;
  return (
    <div className="start-guide">
      <h2>시작하기</h2>
      <p className="hint">
        {done === steps.length
          ? '준비가 모두 끝났습니다. 왼쪽 메뉴에서 화면을 선택하세요.'
          : `순서대로 진행하면 고객이 요청을 올릴 수 있습니다. (${done}/${steps.length} 완료)`}
      </p>
      <ol>
        {steps.map(([code, title, desc, ok], i) => (
          <li key={i} className={ok ? 'done' : ''}>
            <span className="step-mark" aria-hidden="true">
              {ok ? '✓' : i + 1}
            </span>
            <div>
              <strong>{title}</strong>
              <small>{desc}</small>
            </div>
            {canOpen(code) && <button onClick={() => onOpen(code)}>열기</button>}
          </li>
        ))}
      </ol>
    </div>
  );
}
